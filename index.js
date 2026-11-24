require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { CLIENTES, systemPromptDe } = require("./clientes");

// ──────────────────────────────────────────────
// Configuración
// ──────────────────────────────────────────────
const MODEL = process.env.BOT_MODEL || "claude-haiku-5-5";
const EFFORT = process.env.BOT_EFFORT || "low"; // chat corto: low es rápido y barato
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";
const DRY_RUN = process.env.DRY_RUN === "1"; // no manda nada a WhatsApp, solo lo imprime
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 2500); // junta mensajes seguidos
const CONV_TTL_MS = 24 * 60 * 60 * 1000; // la conversación se olvida tras 24h sin mensajes
const MAX_MENSAJES_HISTORIAL = 40;
const PAUSA_HUMANO_HORAS = Number(process.env.PAUSA_HUMANO_HORAS || 12);
const LIMITE_MENSAJES = 15; // por contacto…
const LIMITE_VENTANA_MS = 10 * 60 * 1000; // …cada 10 minutos (protege el gasto de API)

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
  timeout: 30000,
  maxRetries: 2,
});

const app = express();
// Guardamos el body crudo para poder verificar la firma de Meta.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ──────────────────────────────────────────────
// Estado en memoria (se reinicia si se reinicia el servidor)
// ──────────────────────────────────────────────
const conversaciones = new Map(); // clave → { messages, ultimo }
const pausas = new Map();         // clave → timestamp hasta cuándo el bot no contesta
const vistos = new Map();         // message.id → timestamp (Meta a veces reenvía el mismo webhook)
const buffers = new Map();        // clave → { textos, timer, ctx }
const procesando = new Set();     // claves con una respuesta en curso
const historialRate = new Map();  // clave → [timestamps]

const claveDe = (phoneId, contacto) => `${phoneId}:${contacto}`;

// México: WhatsApp entrega los números como 521 + 10 dígitos, pero al enviar
// hay que usar 52 + 10 dígitos (el "1" de celular desapareció en 2019 y Meta
// rechaza el formato viejo, sobre todo con números de prueba). Normalizamos
// todo a 52XXXXXXXXXX para que envíos, pausas y comandos usen la misma clave.
function normalizarNumero(n) {
  const d = String(n || "").replace(/\D/g, "");
  return /^521\d{10}$/.test(d) ? "52" + d.slice(3) : d;
}

// Lo que escribe el dueño en un comando: acepta "667 123 4567", "+52 1 667…", etc.
function numeroDeComando(arg) {
  const d = String(arg || "").replace(/\D/g, "");
  return normalizarNumero(/^\d{10}$/.test(d) ? "52" + d : d);
}

setInterval(() => {
  const ahora = Date.now();
  for (const [k, c] of conversaciones) if (ahora - c.ultimo > CONV_TTL_MS) conversaciones.delete(k);
  for (const [k, t] of vistos) if (ahora - t > 60 * 60 * 1000) vistos.delete(k);
  for (const [k, hasta] of pausas) if (ahora > hasta) pausas.delete(k);
  for (const [k, ts] of historialRate) {
    const vigentes = ts.filter((t) => ahora - t < LIMITE_VENTANA_MS);
    if (vigentes.length) historialRate.set(k, vigentes); else historialRate.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ──────────────────────────────────────────────
// Registros (citas, interesados, transferencias) en archivos JSONL
// En Railway monta un Volume y apunta DATA_DIR a él para que no se borren.
// ──────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });

function guardarRegistro(tipo, registro) {
  const linea = JSON.stringify({ ...registro, creado: new Date().toISOString() });
  fs.appendFileSync(path.join(DATA_DIR, `${tipo}.jsonl`), linea + "\n");
}

function leerRegistros(tipo, { clienteId, limite = 20 } = {}) {
  const archivo = path.join(DATA_DIR, `${tipo}.jsonl`);
  if (!fs.existsSync(archivo)) return [];
  return fs
    .readFileSync(archivo, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && (!clienteId || r.clienteId === clienteId))
    .slice(-limite);
}

// ──────────────────────────────────────────────
// Detección de respuestas automáticas de negocios
// (solo para campañas de ventas: no contestarle a otro bot)
// ──────────────────────────────────────────────
const PATRONES_AUTORESPUESTA = [
  /gracias por comunicarte/i,
  /gracias por tu mensaje/i,
  /en este momento no (podemos|estamos)/i,
  /no estamos disponibles/i,
  /fuera de (nuestro )?horario/i,
  /nuestro horario de atenci[oó]n es/i,
  /te responderemos (lo antes posible|tan pronto|en breve)/i,
  /mensaje autom[aá]tico/i,
  /respuesta autom[aá]tica/i,
  /no podemos responder/i,
];

const esRespuestaAutomatica = (texto) => PATRONES_AUTORESPUESTA.some((p) => p.test(texto));

// ──────────────────────────────────────────────
// Herramientas que Claude puede usar
// ──────────────────────────────────────────────
const TOOL_TRANSFERIR = {
  name: "transferir_a_humano",
  description:
    "Pausa el bot para este contacto y avisa al dueño para que una persona continúe la conversación. " +
    "Úsala si piden hablar con una persona, si hay una urgencia, una queja, o algo que no puedes resolver.",
  input_schema: {
    type: "object",
    properties: {
      motivo: { type: "string", description: "Resumen breve de por qué se transfiere y qué necesita el contacto." },
    },
    required: ["motivo"],
  },
};

const TOOL_CITA = {
  name: "registrar_cita",
  description:
    "Registra una solicitud de cita y avisa al consultorio para que la confirme. " +
    "Úsala solo cuando ya tengas nombre del paciente, motivo y día/hora preferidos y el paciente esté de acuerdo.",
  input_schema: {
    type: "object",
    properties: {
      nombre_paciente: { type: "string" },
      motivo: { type: "string", description: "Servicio o motivo de la consulta." },
      fecha_hora_preferida: { type: "string", description: "Fecha exacta y hora, p. ej. 'viernes 27 de noviembre, 5:00 pm'." },
      notas: { type: "string", description: "Cualquier detalle útil (primera vez, dolor, alternativa de horario). Vacío si no hay." },
    },
    required: ["nombre_paciente", "motivo", "fecha_hora_preferida"],
  },
};

const TOOL_INTERESADO = {
  name: "registrar_interesado",
  description: "Registra a un negocio interesado en una demo y avisa al equipo de ventas.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre de la persona." },
      negocio: { type: "string", description: "Nombre y giro del negocio." },
      notas: { type: "string", description: "Dudas, ciudad o lo que pidió. Vacío si no hay." },
    },
    required: ["nombre", "negocio"],
  },
};

const herramientasDe = (cliente) =>
  cliente.tipo === "clinica" || cliente.tipo === "citas" ? [TOOL_CITA, TOOL_TRANSFERIR]
  : cliente.tipo === "ventas" ? [TOOL_INTERESADO, TOOL_TRANSFERIR]
  : [TOOL_TRANSFERIR];

async function ejecutarHerramienta(nombre, input, ctx) {
  const { cliente, clienteId, contacto, phoneId, clave } = ctx;
  const base = { clienteId, cliente: cliente.nombre, contacto };

  // En la página de demo no se guarda nada ni se avisa a nadie: solo se muestra qué pasaría.
  if (ctx.demo) {
    ctx.eventos.push({ herramienta: nombre, datos: input });
    if (nombre === "registrar_cita") return "Solicitud registrada (demo). Dile al cliente que el negocio le confirmará.";
    if (nombre === "transferir_a_humano") return "Transferido (demo). Avísale que una persona le escribirá pronto.";
    return "Registrado (demo).";
  }

  if (nombre === "registrar_cita") {
    guardarRegistro("citas", { ...base, ...input });
    await avisarDueno(ctx,
      `📅 Nueva solicitud de cita\n` +
      `${cliente.tipo === "clinica" ? "Paciente" : "Cliente"}: ${input.nombre_paciente}\nMotivo: ${input.motivo}\n` +
      `Cuándo: ${input.fecha_hora_preferida}\n` +
      (input.notas ? `Notas: ${input.notas}\n` : "") +
      `WhatsApp: +${contacto}\n\nConfírmale directamente al paciente.`);
    return "Solicitud registrada y enviada al consultorio. Dile al paciente que el consultorio le confirmará.";
  }

  if (nombre === "registrar_interesado") {
    guardarRegistro("interesados", { ...base, ...input });
    await avisarDueno(ctx,
      `🔥 Prospecto interesado\nNombre: ${input.nombre}\nNegocio: ${input.negocio}\n` +
      (input.notas ? `Notas: ${input.notas}\n` : "") + `WhatsApp: +${contacto}`);
    return "Interesado registrado. Dile que en breve lo contactan para preparar su demo.";
  }

  if (nombre === "transferir_a_humano") {
    pausas.set(clave, Date.now() + PAUSA_HUMANO_HORAS * 60 * 60 * 1000);
    guardarRegistro("transferencias", { ...base, ...input });
    await avisarDueno(ctx,
      `🙋 Un contacto necesita atención personal\nWhatsApp: +${contacto}\nMotivo: ${input.motivo}\n\n` +
      `El bot no le contestará por ${PAUSA_HUMANO_HORAS}h. Para reactivarlo manda: #reanudar ${contacto}`);
    return "Transferido. Avísale que una persona le escribirá pronto. No sigas atendiendo el tema.";
  }

  return `Herramienta desconocida: ${nombre}`;
}

// ──────────────────────────────────────────────
// Conversación con Claude
// ──────────────────────────────────────────────
function fechaActual(zona) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: zona || "America/Mexico_City",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

// Recorta el historial sin romper la estructura: debe empezar con un mensaje
// del usuario que no sea resultado de herramienta. Como eso cambia el inicio
// de la conversación, quitamos los bloques de "thinking" de lo que queda
// (la API los invalida si cambia lo que había antes de ellos).
function recortarHistorial(messages) {
  if (messages.length <= MAX_MENSAJES_HISTORIAL) return messages;
  let inicio = messages.length - MAX_MENSAJES_HISTORIAL;
  const esInicioValido = (m) =>
    m.role === "user" &&
    (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
  while (inicio < messages.length && !esInicioValido(messages[inicio])) inicio++;
  return messages.slice(inicio).map((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") }
      : m
  );
}

const limpiarFormato = (t) => t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "").trim();

async function responderConClaude(ctx, textoUsuario) {
  const { cliente, clave } = ctx;
  const conv = conversaciones.get(clave) || { messages: [], ultimo: 0 };
  conv.ultimo = Date.now();
  conv.messages = recortarHistorial(conv.messages);
  conversaciones.set(clave, conv);

  const tamañoAntes = conv.messages.length;
  conv.messages.push({
    role: "user",
    content: `[Fecha y hora actual: ${fechaActual(cliente.zonaHoraria)}]\n${textoUsuario}`,
  });

  const system = [{ type: "text", text: systemPromptDe(cliente), cache_control: { type: "ephemeral" } }];
  const tools = herramientasDe(cliente);

  try {
    for (let paso = 0; paso < 4; paso++) {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        output_config: { effort: EFFORT },
        system,
        tools,
        messages: conv.messages,
      });

      if (resp.stop_reason === "refusal") {
        console.warn(`⚠️  [${cliente.nombre}] Claude declinó responder (${resp.stop_details?.category || "sin categoría"})`);
        conv.messages.length = tamañoAntes; // no guardamos el turno rechazado
        return "Disculpa, con eso no puedo ayudarte por aquí. ¿Hay algo más en lo que te pueda apoyar?";
      }

      // Se guarda el contenido completo (incluye bloques de thinking) tal cual.
      conv.messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason === "tool_use") {
        const resultados = [];
        for (const bloque of resp.content) {
          if (bloque.type !== "tool_use") continue;
          console.log(`🔧 [${cliente.nombre}] ${bloque.name} ${JSON.stringify(bloque.input)}`);
          try {
            const r = await ejecutarHerramienta(bloque.name, bloque.input, ctx);
            resultados.push({ type: "tool_result", tool_use_id: bloque.id, content: r });
          } catch (e) {
            console.error(`❌ Herramienta ${bloque.name} falló:`, e.message);
            resultados.push({ type: "tool_result", tool_use_id: bloque.id, content: `Error: ${e.message}`, is_error: true });
          }
        }
        conv.messages.push({ role: "user", content: resultados });
        continue;
      }

      const texto = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (texto.trim()) return limpiarFormato(texto);
      console.warn(`⚠️  [${cliente.nombre}] Respuesta sin texto (stop_reason=${resp.stop_reason})`);
      break;
    }
  } catch (err) {
    conv.messages.length = tamañoAntes; // deja el historial como estaba
    if (err instanceof Anthropic.RateLimitError) console.error("❌ Claude: límite de uso alcanzado");
    else if (err instanceof Anthropic.AuthenticationError) console.error("❌ Claude: API key inválida");
    else if (err instanceof Anthropic.APIError) console.error(`❌ Claude API ${err.status}:`, err.message);
    else console.error("❌ Error llamando a Claude:", err.message);
    throw err;
  }

  conv.messages.length = tamañoAntes;
  return null;
}

// ──────────────────────────────────────────────
// Cola por contacto: junta mensajes seguidos ("hola" / "quiero cita" / "mañana")
// y garantiza una sola respuesta a la vez por conversación.
// ──────────────────────────────────────────────
function encolar(clave, texto, ctx) {
  const b = buffers.get(clave) || { textos: [], timer: null, ctx };
  b.textos.push(texto);
  b.ctx = ctx;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => procesarCola(clave), DEBOUNCE_MS);
  buffers.set(clave, b);
}

async function procesarCola(clave) {
  if (procesando.has(clave)) return; // se reintenta al terminar la respuesta actual
  const b = buffers.get(clave);
  if (!b || !b.textos.length) return;
  buffers.delete(clave);

  const { ctx } = b;
  if (pausas.has(clave) && Date.now() < pausas.get(clave)) return; // lo atiende una persona

  procesando.add(clave);
  try {
    const texto = b.textos.join("\n");
    const respuesta = await responderConClaude(ctx, texto);
    if (respuesta) {
      console.log(`🤖 [${ctx.cliente.nombre}] → ${ctx.contacto}: ${respuesta}`);
      await enviarMensaje(ctx.phoneId, ctx.contacto, respuesta);
    }
  } catch (err) {
    const tel = ctx.cliente.datos?.telefono;
    await enviarMensaje(ctx.phoneId, ctx.contacto,
      tel ? `Disculpa, tuve un problema técnico. Puedes escribirme de nuevo en un momento o llamar al ${tel}.`
          : "Disculpa, tuve un problema técnico. ¿Me escribes de nuevo en un momento?"
    ).catch(() => {});
  } finally {
    procesando.delete(clave);
    const pendiente = buffers.get(clave);
    if (pendiente && pendiente.textos.length) {
      clearTimeout(pendiente.timer);
      pendiente.timer = setTimeout(() => procesarCola(clave), 300);
    }
  }
}

// ──────────────────────────────────────────────
// Comandos del dueño (mandados desde el número notificarA)
// ──────────────────────────────────────────────
async function manejarComando(ctx, texto) {
  const [cmd, ...resto] = texto.trim().split(/\s+/);
  const arg = resto.join(" ");
  const numero = numeroDeComando(arg);
  let r;

  switch (cmd.toLowerCase()) {
    case "#citas":
    case "#registros": {
      const tipo = ctx.cliente.tipo === "ventas" ? "interesados" : "citas";
      const regs = leerRegistros(tipo, { clienteId: ctx.clienteId, limite: 5 });
      r = regs.length
        ? `Últimos ${regs.length} (${tipo}):\n\n` + regs.map((x) =>
            tipo === "citas"
              ? `• ${x.nombre_paciente} — ${x.motivo} — ${x.fecha_hora_preferida} (+${x.contacto})`
              : `• ${x.nombre} — ${x.negocio} (+${x.contacto})`
          ).join("\n")
        : `No hay ${tipo} registradas todavía.`;
      break;
    }
    case "#pausa":
      if (!numero) { r = "Uso: #pausa 5216671234567"; break; }
      pausas.set(claveDe(ctx.phoneId, numero), Date.now() + PAUSA_HUMANO_HORAS * 60 * 60 * 1000);
      r = `Listo, el bot no le contestará a +${numero} por ${PAUSA_HUMANO_HORAS}h.`;
      break;
    case "#reanudar":
      if (!numero) { r = "Uso: #reanudar 5216671234567"; break; }
      pausas.delete(claveDe(ctx.phoneId, numero));
      r = `Listo, el bot vuelve a contestarle a +${numero}.`;
      break;
    case "#pausados": {
      const lista = [...pausas.entries()]
        .filter(([k, hasta]) => k.startsWith(ctx.phoneId + ":") && hasta > Date.now())
        .map(([k]) => "+" + k.split(":")[1]);
      r = lista.length ? `Pausados:\n${lista.join("\n")}` : "No hay contactos pausados.";
      break;
    }
    default:
      r = "Comandos:\n#citas — últimas solicitudes\n#pausa <número> — el bot deja de contestarle\n" +
          "#reanudar <número> — el bot vuelve a contestarle\n#pausados — ver pausados";
  }
  await enviarMensaje(ctx.phoneId, ctx.contacto, r);
}

// ──────────────────────────────────────────────
// WhatsApp Cloud API
// ──────────────────────────────────────────────
const graphHeaders = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
});

async function enviarMensaje(phoneNumberId, destinatario, texto) {
  if (DRY_RUN) {
    console.log(`📤 [DRY_RUN] ${phoneNumberId} → ${destinatario}: ${texto}`);
    return;
  }
  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    { messaging_product: "whatsapp", to: destinatario, type: "text", text: { body: texto } },
    { headers: graphHeaders(), timeout: 15000 }
  );
}

async function marcarLeido(phoneNumberId, messageId) {
  if (DRY_RUN) return;
  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    { messaging_product: "whatsapp", status: "read", message_id: messageId },
    { headers: graphHeaders(), timeout: 10000 }
  ).catch(() => {}); // no es crítico
}

async function avisarDueno(ctx, texto) {
  const dueno = normalizarNumero(ctx.cliente.notificarA);
  if (!dueno) {
    console.log(`📣 [${ctx.cliente.nombre}] (sin notificarA configurado) ${texto}`);
    return;
  }
  try {
    await enviarMensaje(ctx.phoneId, dueno, texto);
  } catch (err) {
    // Fuera de la ventana de 24h WhatsApp no deja mandar texto libre:
    // el dueño debe escribirle al bot de vez en cuando (ej. "#citas").
    console.error(`❌ No se pudo avisar al dueño (${dueno}):`, JSON.stringify(err.response?.data?.error || err.message));
  }
}

function textoDeMensaje(m) {
  switch (m.type) {
    case "text": return m.text?.body;
    case "button": return m.button?.text; // respuesta rápida de una plantilla
    case "interactive": return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
    default: return null;
  }
}

function firmaValida(req) {
  const secreto = process.env.APP_SECRET;
  if (!secreto) return true; // sin APP_SECRET no se verifica (ver aviso al arrancar)
  const firma = req.get("x-hub-signature-256") || "";
  const esperado = "sha256=" + crypto.createHmac("sha256", secreto).update(req.rawBody || "").digest("hex");
  const a = Buffer.from(firma), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function excedeLimite(clave) {
  const ahora = Date.now();
  const ts = (historialRate.get(clave) || []).filter((t) => ahora - t < LIMITE_VENTANA_MS);
  ts.push(ahora);
  historialRate.set(clave, ts);
  return ts.length > LIMITE_MENSAJES;
}

// ──────────────────────────────────────────────
// GET /webhook  →  verificación del webhook Meta
// ──────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Verificación fallida — token incorrecto");
  res.sendStatus(403);
});

// ──────────────────────────────────────────────
// POST /webhook  →  mensajes entrantes
// ──────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  if (!firmaValida(req)) {
    console.warn("❌ Webhook con firma inválida, ignorado");
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      for (const message of value?.messages || []) {
        manejarMensaje(message, value).catch((e) =>
          console.error("❌ Error al procesar mensaje:", e.message)
        );
      }
    }
  }
});

async function manejarMensaje(message, value) {
  if (vistos.has(message.id)) return; // duplicado
  vistos.set(message.id, Date.now());

  const phoneNumberId = value?.metadata?.phone_number_id;
  const contacto = normalizarNumero(message.from);

  // Si el número no está configurado, se usa el del .env (útil para pruebas)
  const clienteId = CLIENTES[phoneNumberId] ? phoneNumberId : process.env.PHONE_NUMBER_ID;
  const cliente = CLIENTES[clienteId] || { tipo: "generico", nombre: "Demo" };
  const phoneId = CLIENTES[phoneNumberId] ? phoneNumberId : process.env.PHONE_NUMBER_ID;
  const clave = claveDe(phoneId, contacto);
  const ctx = { cliente, clienteId, contacto, phoneId, clave };

  const texto = textoDeMensaje(message);

  if (!texto) {
    console.log(`📎 [${cliente.nombre}] ${contacto} mandó ${message.type}`);
    if (["audio", "image", "video", "document", "sticker"].includes(message.type) && !pausas.has(clave)) {
      await enviarMensaje(phoneId, contacto,
        "Por ahora solo puedo leer mensajes de texto 🙏 ¿Me escribes lo que necesitas?");
    }
    return;
  }

  console.log(`📩 [${cliente.nombre}] ${contacto}: ${texto}`);

  if (cliente.notificarA && contacto === normalizarNumero(cliente.notificarA) && texto.trim().startsWith("#")) {
    return manejarComando(ctx, texto);
  }

  if (pausas.has(clave) && Date.now() < pausas.get(clave)) {
    console.log(`⏸️  [${cliente.nombre}] ${contacto} está con una persona, el bot no contesta.`);
    return;
  }

  if (cliente.tipo === "ventas" && esRespuestaAutomatica(texto)) {
    console.log(`⏭️  [${cliente.nombre}] Parece autorespuesta de negocio, no contesto.`);
    return;
  }

  if (excedeLimite(clave)) {
    console.warn(`🚫 [${cliente.nombre}] ${contacto} excedió el límite de mensajes, ignorado.`);
    return;
  }

  marcarLeido(phoneId, message.id);
  encolar(clave, texto, ctx);
}

// ──────────────────────────────────────────────
// Endpoints de administración
// Si defines ADMIN_TOKEN, piden ?token=... (recomendado en producción)
// ──────────────────────────────────────────────
function autorizado(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.query.token === token) return true;
  res.sendStatus(401);
  return false;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, modelo: MODEL, clientes: Object.keys(CLIENTES).length, conversaciones: conversaciones.size });
});

// GET /admin/registros?tipo=citas|interesados|transferencias&token=...
app.get("/admin/registros", (req, res) => {
  if (!process.env.ADMIN_TOKEN) return res.status(403).json({ error: "Define ADMIN_TOKEN para usar este endpoint" });
  if (!autorizado(req, res)) return;
  const tipo = ["citas", "interesados", "transferencias"].includes(req.query.tipo) ? req.query.tipo : "citas";
  res.json(leerRegistros(tipo, { clienteId: req.query.cliente, limite: 100 }));
});

// Suscribir un número a los webhooks: GET /setup-webhook?phone_number_id=XXXX
app.get("/setup-webhook", async (req, res) => {
  if (!autorizado(req, res)) return;
  const phoneNumberId = req.query.phone_number_id || process.env.PHONE_NUMBER_ID;
  try {
    const r = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/subscribed_apps`,
      {},
      { headers: graphHeaders() }
    );
    res.json({ ok: true, phoneNumberId, resultado: r.data });
  } catch (err) {
    res.json({ ok: false, phoneNumberId, error: err.message, detalle: err.response?.data });
  }
});

// ──────────────────────────────────────────────
// Página de demo para enseñar el bot a prospectos sin usar WhatsApp:
//   https://<tu-app>/demo?c=demo-lf-salon
// Usa Claude de verdad, así que tiene límite por sesión y por día.
// ──────────────────────────────────────────────
const DEMO_LIMITE_DIA = Number(process.env.DEMO_LIMITE_DIA || 300);
let demoUso = { dia: "", mensajes: 0 };

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// El nombre del negocio va en el HTML para que la vista previa del link
// (Messenger, WhatsApp, Facebook) muestre "Así contestaría el WhatsApp de X".
app.get("/demo", (req, res) => {
  const c = CLIENTES[req.query.c || "demo-lf-salon"];
  const nombre = c && c.tipo !== "ventas" ? c.nombre : "tu negocio";
  const host = /^[\w.-]+(:\d+)?$/.test(req.get("host") || "") ? req.get("host") : "localhost";
  const base = `${/^(localhost|127\.)/.test(host) ? "http" : "https"}://${host}`;
  const html = fs.readFileSync(path.join(__dirname, "demo.html"), "utf8")
    .replaceAll("{{NOMBRE}}", escHtml(nombre))
    .replaceAll("{{BASE}}", base);
  res.type("html").send(html);
});

app.get("/demo/logo.png", (_req, res) => res.sendFile(path.join(__dirname, "assets", "sitiolab-logo.png")));

app.get("/demo/info", (req, res) => {
  const c = CLIENTES[req.query.c];
  if (!c || c.tipo === "ventas") return res.status(404).json({ error: "Demo no encontrada" });
  res.json({ nombre: c.nombre, giro: c.datos?.giro || "", horario: c.datos?.horario || "", sugerencias: c.sugerencias || [] });
});

app.post("/demo/mensaje", async (req, res) => {
  const { c, sesion, texto } = req.body || {};
  const cliente = CLIENTES[c];
  if (!cliente || cliente.tipo === "ventas") return res.status(404).json({ error: "Demo no encontrada" });
  if (typeof texto !== "string" || !texto.trim() || texto.length > 1000 || !/^[\w-]{8,64}$/.test(sesion || "")) {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const hoy = new Date().toISOString().slice(0, 10);
  if (demoUso.dia !== hoy) demoUso = { dia: hoy, mensajes: 0 };
  const clave = claveDe("demo", `${c}:${sesion}`);
  if (demoUso.mensajes >= DEMO_LIMITE_DIA || excedeLimite(clave)) {
    return res.status(429).json({ error: "La demo alcanzó su límite por hoy. Intenta más tarde." });
  }
  demoUso.mensajes++;

  if (pausas.has(clave) && Date.now() < pausas.get(clave)) {
    return res.json({ respuesta: null, eventos: [], pausado: true });
  }

  const ctx = { cliente, clienteId: c, contacto: "demo", phoneId: "demo", clave, demo: true, eventos: [] };
  try {
    const respuesta = await responderConClaude(ctx, texto.trim());
    const transferido = ctx.eventos.some((e) => e.herramienta === "transferir_a_humano");
    if (transferido) pausas.set(clave, Date.now() + 30 * 60 * 1000);
    res.json({ respuesta, eventos: ctx.eventos });
  } catch {
    res.status(502).json({ error: "No pude responder en este momento. Intenta de nuevo." });
  }
});

// Diagnóstico: probar conexión con Claude
app.get("/test-claude", async (req, res) => {
  if (!autorizado(req, res)) return;
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "di hola" }],
    });
    res.json({ ok: true, modelo: MODEL, respuesta: r.content.filter((b) => b.type === "text").map((b) => b.text).join("") });
  } catch (err) {
    res.json({ ok: false, error: err.message, status: err.status });
  }
});

// ──────────────────────────────────────────────
// Arrancar servidor
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Clientes configurados: ${Object.keys(CLIENTES).length} · modelo ${MODEL} · effort ${EFFORT}`);
  if (DRY_RUN) console.log("🧪 DRY_RUN activo: no se envía nada a WhatsApp");
  if (!process.env.APP_SECRET) console.warn("⚠️  Sin APP_SECRET: no se verifica que los webhooks vengan de Meta");
  if (!process.env.ADMIN_TOKEN) console.warn("⚠️  Sin ADMIN_TOKEN: /setup-webhook y /test-claude quedan abiertos");
  if (!process.env.OWNER_PHONE) console.warn("⚠️  Sin OWNER_PHONE: los avisos de citas solo se verán en los logs");
});
