require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ──────────────────────────────────────────────
// CLIENTES — agrega uno por cada cliente nuevo
// Key = Phone Number ID que te da Meta al registrar el número
// ──────────────────────────────────────────────
const CLIENTES = {
  // Número de prueba Meta (para testing)
  "1247152665138001": {
    nombre: "Clínica Dental Sonrisa",
    prompt:
      "Eres el asistente virtual de Clínica Dental Sonrisa, ubicada en Av. Insurgentes 245, Culiacán, Sinaloa. " +
      "El doctor a cargo es el Dr. Ramírez. " +
      "Horario: lunes a viernes de 9am a 7pm, sábados de 9am a 2pm. " +
      "Servicios: limpieza dental $400, extracción desde $500, blanqueamiento $1,800, ortodoncia desde $8,000, consulta de valoración GRATIS. " +
      "Para agendar cita pide el nombre del paciente y el horario que le acomoda. " +
      "Si no sabes algo responde: 'Con gusto te comunico con nosotros al 667-123-4567'. " +
      "Responde siempre en español, amable y profesional. Máximo 3 líneas por respuesta.",
  },

  // Número real de Sitiolab — recibe respuestas a la campaña de marketing
  "1121554081051619": {
    nombre: "Sitiolab",
    prompt:
      "Eres el asistente de ventas de Sitiolab. Le acabas de mandar un mensaje de WhatsApp a este negocio ofreciéndole " +
      "un asistente de WhatsApp con inteligencia artificial que responde preguntas y agenda citas automáticamente, las 24 horas. " +
      "Si responden con interés (dicen que sí, hacen preguntas, piden más información), explícales brevemente cómo funciona: " +
      "se conecta a su número de WhatsApp actual, responde con base en la información de su negocio (horarios, servicios, precios) " +
      "y agenda citas sin que el dueño tenga que estar pendiente del celular todo el día. " +
      "Costo aproximado: instalación desde $2,500 MXN, más una mensualidad desde $800 MXN que incluye actualizaciones menores. " +
      "Si quieren seguir adelante, pide su nombre y giro del negocio para preparar una demo personalizada. " +
      "Si dicen que no les interesa o piden que no les escriban más, agradece y despídete cordialmente sin insistir. " +
      "Responde siempre en español, de forma natural, amable y breve (máximo 4 líneas). No repitas literalmente el mensaje que ya se les envió.",
  },

  // ── Agrega clientes reales así: ──────────────
  // "PHONE_NUMBER_ID_DEL_CLIENTE": {
  //   nombre: "Clínica Dental Sonrisa",
  //   prompt:
  //     "Eres el asistente virtual de Clínica Dental Sonrisa, " +
  //     "ubicada en Av. Insurgentes 245, Culiacán, Sinaloa. " +
  //     "Horario: lunes a viernes 9am-7pm, sábados 9am-2pm. " +
  //     "Servicios: limpieza $400, extracción desde $500, blanqueamiento $1,800. " +
  //     "Para citas pide nombre y horario disponible. " +
  //     "Responde en español, amable, máximo 3 líneas.",
  // },
};

const PROMPT_DEFAULT =
  "Eres un asistente amable. Responde en español, máximo 3 líneas.";

// ──────────────────────────────────────────────
// Detección de respuestas automáticas de negocios
// (para no contestarle a otro bot / autorespondedor)
// ──────────────────────────────────────────────
const PATRONES_AUTORESPUESTA = [
  /gracias por comunicarte/i,
  /gracias por tu mensaje/i,
  /en este momento no (podemos|estamos)/i,
  /no estamos disponibles/i,
  /fuera de (nuestro )?horario/i,
  /horario de atenci[oó]n/i,
  /te responderemos (lo antes posible|tan pronto|en breve)/i,
  /mensaje autom[aá]tico/i,
  /respuesta autom[aá]tica/i,
  /no podemos responder/i,
];

function esRespuestaAutomatica(texto) {
  return PATRONES_AUTORESPUESTA.some((patron) => patron.test(texto));
}

// ──────────────────────────────────────────────
// GET /webhook  →  verificación del webhook Meta
// ──────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
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
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry    = body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const message  = value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from         = message.from;
    const texto        = message.text.body;
    const phoneNumberId = value?.metadata?.phone_number_id;

    // Buscar cliente por su Phone Number ID
    const cliente = CLIENTES[phoneNumberId];
    const systemPrompt = cliente?.prompt || CLIENTES[process.env.PHONE_NUMBER_ID]?.prompt || PROMPT_DEFAULT;
    const nombreCliente = cliente?.nombre || CLIENTES[process.env.PHONE_NUMBER_ID]?.nombre || "Demo";
    const phoneIdEnvio = cliente ? phoneNumberId : process.env.PHONE_NUMBER_ID;

    console.log(`📩 [${nombreCliente}] Mensaje de ${from}: ${texto}`);

    if (esRespuestaAutomatica(texto)) {
      console.log(`⏭️  [${nombreCliente}] Parece autorespuesta de negocio, no contesto.`);
      return;
    }

    const respuesta = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: texto }],
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const textoRespuesta = respuesta.data.content[0].text;
    console.log(`🤖 [${nombreCliente}] Claude responde: ${textoRespuesta}`);

    await enviarMensaje(phoneIdEnvio, from, textoRespuesta);

  } catch (err) {
    console.error("❌ Error al procesar mensaje:", err.message);
    console.error("❌ HTTP status:", err.response?.status);
    console.error("❌ Detalle:", JSON.stringify(err.response?.data || {}));
  }
});

// ──────────────────────────────────────────────
// Función auxiliar: enviar mensaje por WhatsApp
// Usa el phoneNumberId correcto para cada cliente
// ──────────────────────────────────────────────
async function enviarMensaje(phoneNumberId, destinatario, texto) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: destinatario,
      type: "text",
      text: { body: texto },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ──────────────────────────────────────────────
// Suscribir un número de teléfono a los webhooks de la app
// Uso: GET /setup-webhook?phone_number_id=XXXXXXXXXX
// (si se omite el query param, usa PHONE_NUMBER_ID del .env)
// ──────────────────────────────────────────────
app.get("/setup-webhook", async (req, res) => {
  const phoneNumberId = req.query.phone_number_id || process.env.PHONE_NUMBER_ID;
  try {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    res.json({ ok: true, phoneNumberId, resultado: r.data });
  } catch (err) {
    res.json({ ok: false, phoneNumberId, error: err.message, detalle: err.response?.data });
  }
});

// ──────────────────────────────────────────────
// Diagnóstico: probar conexión con Claude
// ──────────────────────────────────────────────
app.get("/test-claude", async (req, res) => {
  try {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "di hola" }],
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );
    res.json({ ok: true, respuesta: r.data.content[0].text });
  } catch (err) {
    res.json({ ok: false, error: err.message, status: err.response?.status });
  }
});

// ──────────────────────────────────────────────
// Arrancar servidor
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Clientes configurados: ${Object.keys(CLIENTES).length}`);
});
