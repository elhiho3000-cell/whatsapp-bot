require("dotenv").config();
const fs = require("fs");
const axios = require("axios");

const SOURCE_CSV = "C:/Users/Usuario/Downloads/prospectos-con-numero.csv";
const RESULTS_CSV = __dirname + "/campaign-results.csv";
const TEMPLATE_NAME = "asistente_ia_negocios_v2";
const LANGUAGE_CODE = "es_MX";
const BATCH_SIZE = 230; // margen bajo el límite de TIER_250 (250 conversaciones/24h)
const DELAY_MS = 1200;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length && r.some((v) => v.trim()));
}

function csvEscape(v) {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function loadProspectos() {
  const text = fs.readFileSync(SOURCE_CSV, "utf8");
  const rows = parseCsv(text);
  const [header, ...data] = rows;
  const idx = {
    nombre: header.indexOf("nombre"),
    categoria: header.indexOf("categoria"),
    ciudad: header.indexOf("ciudad"),
    telefono: header.indexOf("telefono"),
  };
  return data.map((r) => ({
    nombre: r[idx.nombre] || "",
    categoria: r[idx.categoria] || "",
    ciudad: r[idx.ciudad] || "",
    telefono: (r[idx.telefono] || "").trim(),
  }));
}

function dedupeByPhone(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item.telefono || seen.has(item.telefono)) continue;
    seen.add(item.telefono);
    out.push(item);
  }
  return out;
}

function loadSuccessSet() {
  if (!fs.existsSync(RESULTS_CSV)) return new Set();
  const rows = parseCsv(fs.readFileSync(RESULTS_CSV, "utf8"));
  const [header, ...data] = rows;
  const phoneIdx = header.indexOf("telefono");
  const statusIdx = header.indexOf("status");
  const set = new Set();
  for (const r of data) {
    if (r[statusIdx] === "success") set.add(r[phoneIdx]);
  }
  return set;
}

function appendResult(row) {
  const isNew = !fs.existsSync(RESULTS_CSV);
  if (isNew) {
    fs.writeFileSync(
      RESULTS_CSV,
      "nombre,categoria,ciudad,telefono,status,error,timestamp\n"
    );
  }
  const line = [
    row.nombre,
    row.categoria,
    row.ciudad,
    row.telefono,
    row.status,
    row.error || "",
    new Date().toISOString(),
  ]
    .map(csvEscape)
    .join(",");
  fs.appendFileSync(RESULTS_CSV, line + "\n");
}

async function sendTemplate(item) {
  const to = item.telefono.replace(/^\+/, "");
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: LANGUAGE_CODE },
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              parameter_name: "nombre_negocio",
              text: item.nombre,
            },
          ],
        },
      ],
    },
  };
  return axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const all = dedupeByPhone(loadProspectos());
  const alreadySent = loadSuccessSet();
  const pending = all.filter((r) => !alreadySent.has(r.telefono));

  console.log(`Total negocios únicos: ${all.length}`);
  console.log(`Ya enviados con éxito: ${alreadySent.size}`);
  console.log(`Pendientes: ${pending.length}`);

  if (pending.length === 0) {
    console.log("✅ Campaña completa. No quedan negocios pendientes.");
    return;
  }

  const batch = pending.slice(0, BATCH_SIZE);
  console.log(`Enviando este lote: ${batch.length} negocios...\n`);

  let sent = 0;
  let failed = 0;

  for (const item of batch) {
    try {
      await sendTemplate(item);
      appendResult({ ...item, status: "success" });
      sent++;
      console.log(`✅ ${item.nombre} (${item.telefono})`);
    } catch (err) {
      const errMsg = JSON.stringify(err.response?.data?.error || err.message);
      appendResult({ ...item, status: "failed", error: errMsg });
      failed++;
      console.log(`❌ ${item.nombre} (${item.telefono}) — ${errMsg}`);

      // Si es límite de tasa/conversaciones, detener el lote de una vez.
      const code = err.response?.data?.error?.code;
      if (code === 130429 || code === 131056 || code === 131048) {
        console.log("⚠️  Límite de mensajería alcanzado, deteniendo este lote.");
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  const remaining = pending.length - sent;
  console.log(`\nResumen del lote: ${sent} enviados, ${failed} fallidos.`);
  console.log(`Quedan pendientes para el próximo lote: ${remaining}`);
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
