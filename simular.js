// Simula mensajes de WhatsApp contra el bot local, sin usar Meta.
// 1) Arranca el bot en modo prueba:   $env:DRY_RUN="1"; npm start
// 2) En otra terminal:                node simular.js "hola, quiero una limpieza"
//    Opcional: --de 5216670000000  --phone-id 1247152665138001
// Las respuestas del bot aparecen en la terminal del servidor (📤 [DRY_RUN]).
require("dotenv").config();
const crypto = require("crypto");
const axios = require("axios");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : d; };
const de = opt("--de", "5210000000001");
const phoneId = opt("--phone-id", "1247152665138001");
const texto = args.join(" ") || "hola";

const body = {
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: phoneId },
    messages: [{ id: "sim." + crypto.randomUUID(), from: de, type: "text", text: { body: texto } }],
  } }] }],
};

const raw = JSON.stringify(body);
const headers = { "Content-Type": "application/json" };
if (process.env.APP_SECRET) {
  headers["x-hub-signature-256"] = "sha256=" + crypto.createHmac("sha256", process.env.APP_SECRET).update(raw).digest("hex");
}

axios.post(`http://localhost:${process.env.PORT || 3000}/webhook`, raw, { headers })
  .then((r) => console.log(`Enviado (${r.status}): ${de} → "${texto}"`))
  .catch((e) => console.error("Error:", e.message));
