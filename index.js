require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT =
  "Eres el asistente virtual de una clínica dental que atiende en todo México. " +
  "Responde siempre en español, de forma amable y profesional. " +
  "Tus respuestas deben ser concisas: máximo 3 líneas.";

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
  // Meta espera 200 inmediato para no reintentar
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    // Solo procesamos mensajes de texto
    if (!message || message.type !== "text") return;

    const from    = message.from;           // número del cliente
    const texto   = message.text.body;      // texto recibido

    console.log(`📩 Mensaje de ${from}: ${texto}`);

    // ── 1. Llamar a Claude Haiku ──────────────
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: texto }],
    });

    const textoRespuesta = respuesta.content[0].text;
    console.log(`🤖 Claude responde: ${textoRespuesta}`);

    // ── 2. Enviar respuesta por WhatsApp ───────
    await enviarMensaje(from, textoRespuesta);

  } catch (err) {
    console.error("❌ Error al procesar mensaje:", err.message);
    console.error("❌ Error status:", err.status);
    console.error("❌ Error detalle:", JSON.stringify(err.error || {}));
  }
});

// Endpoint de diagnóstico
app.get("/test-claude", async (req, res) => {
  try {
    const r = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "di hola" }],
    });
    res.json({ ok: true, respuesta: r.content[0].text });
  } catch (err) {
    res.json({ ok: false, error: err.message, status: err.status, detalle: err.error });
  }
});

// ──────────────────────────────────────────────
// Función auxiliar: enviar mensaje por WhatsApp
// ──────────────────────────────────────────────
async function enviarMensaje(destinatario, texto) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

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
// Arrancar servidor
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Webhook en http://localhost:${PORT}/webhook`);
});
