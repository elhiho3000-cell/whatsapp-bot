// ──────────────────────────────────────────────
// DEMOS para prospectos. No tienen número de WhatsApp: se prueban en
//   https://<tu-app>/demo?c=<clave>
// Datos públicos sacados de Google Maps. Para agregar una demo, copia un
// bloque y cambia los datos; no hace falta tocar nada más.
// ──────────────────────────────────────────────

const SUGERENCIAS_VET = [
  "Hola, ¿qué horario tienen?",
  "¿Cuánto cuesta una consulta?",
  "Quiero agendar vacunas para mi perro",
  "Mi perro comió algo raro y está vomitando",
];

const REGLAS_VET = [
  "No des diagnósticos ni recomiendes medicamentos o dosis: eso solo lo puede hacer el veterinario después de revisar a la mascota.",
  "Si describen una urgencia (no respira bien, sangra mucho, convulsiona, se envenenó o comió algo tóxico, la atropellaron, no puede levantarse), dile que la traiga de inmediato o llame al teléfono de la clínica, y usa transferir_a_humano.",
  "Para agendar, además del nombre del dueño pregunta el nombre y la especie de la mascota (perro, gato, etc.) y ponlo en el servicio.",
];

const PRECIOS_VET =
  "No tenemos lista de precios publicada. El costo depende de la mascota (especie, tamaño, estado): " +
  "dile que en la clínica se lo confirman y ofrécele agendar una consulta.";

function vet(nombre, datos) {
  return {
    tipo: "citas",
    demo: true,
    nombre,
    zonaHoraria: "America/Tijuana",
    sugerencias: SUGERENCIAS_VET,
    datos: { giro: "clínica veterinaria", precios: PRECIOS_VET, reglas: REGLAS_VET, ...datos },
  };
}

module.exports = {
  // ── Hermosillo ──
  "demo-lf-salon": {
    tipo: "citas",
    demo: true,
    nombre: "LF Salon",
    zonaHoraria: "America/Hermosillo",
    sugerencias: ["Hola, ¿qué horario tienen?", "¿Cuánto cuesta un tinte?", "Quiero agendar una cita", "Quiero hablar con una persona"],
    datos: {
      giro: "salón de belleza",
      direccion: "Juárez 18, col. Bachoco, Hermosillo, Sonora",
      horario: "lunes a sábado de 9am a 7pm, domingos cerrado",
      telefono: "662-304-6766",
      servicios: [
        "Corte de cabello (dama, caballero, cortes para cabello rizado y ondulado)",
        "Tinte y trabajos de color",
        "Mechas y luces",
        "Maquillaje",
        "Peinados para evento",
        "Venta de productos profesionales Avyna para el cuidado del cabello",
      ],
      precios:
        "No tenemos lista de precios publicada. Los precios dependen del largo y estado del cabello: " +
        "dile al cliente que en el salón se lo cotizan al momento y ofrécele agendar.",
      extra: "Las clientas destacan la asesoría personalizada: recomiendan qué productos usar para que el color dure.",
    },
  },

  // ── Tijuana: veterinarias ──
  "vet-otay": vet("Clínica Veterinaria Otay", {
    direccion: "Av. Venustiano Carranza 2130, Otay Constituyentes, Tijuana, B.C.",
    horario: "lunes a sábado de 8am a 12 de la noche, domingos de 12 a 4pm",
    telefono: "664-623-8015",
    servicios: ["Consulta veterinaria", "Vacunación y desparasitación", "Atención a perros, gatos y conejos"],
  }),

  "k-chorro": vet("K-Chorro Vet & Spa", {
    direccion: "Génova 6532, Altamira, Tijuana, B.C.",
    horario: "lunes a viernes de 10am a 6pm, sábados de 9am a 5pm, domingos cerrado",
    telefono: "664-635-2262",
    servicios: ["Consulta veterinaria", "Vacunación y desparasitación", "Spa y estética para mascotas (baño y corte)", "Atención a perros, gatos y conejos"],
  }),

  provet: vet("Provet Clínica Veterinaria Otay", {
    direccion: "Av. José López Portillo Pte. 197, Nueva Tijuana, Tijuana, B.C.",
    horario: "lunes a viernes de 10am a 4:30pm, sábados de 10am a 2pm, domingos cerrado",
    telefono: "664-607-0774",
    servicios: ["Consulta veterinaria", "Vacunación y desparasitación", "Cirugía"],
    formasDePago: "efectivo (confirma otras formas de pago con la clínica)",
  }),

  "centro-medico-vet": vet("Centro Médico Veterinario", {
    direccion: "Calle Ignacio Zaragoza 8091, col. Independencia, Tijuana, B.C.",
    horario: "lunes a viernes de 10am a 8pm, sábados de 10am a 6pm, domingos de 1 a 3pm",
    telefono: "664-638-5091",
    servicios: ["Consulta veterinaria", "Vacunación y desparasitación", "Atención a perros y gatos, también rescatados"],
  }),

  "vet-lucky": vet("Clínica Veterinaria y Estética Lucky", {
    direccion: "Av. de los Grandes Lagos 19720, El Lago, Tijuana, B.C.",
    horario: "martes a sábado de 10am a 5pm, lunes y domingos cerrado",
    telefono: "664-660-1050",
    servicios: ["Consulta veterinaria", "Urgencias en horario de clínica", "Estética para mascotas", "Asesoría y trámites para viajar en avión con mascotas"],
  }),

  "vet-las-palmas": vet("Hospital Veterinario Las Palmas e Hipódromo", {
    direccion: "Av. Las Palmas 4721, Las Palmas, Tijuana, B.C.",
    horario: "lunes a viernes de 8am a 8pm, sábados de 8am a 7pm, domingos de 9am a 5pm",
    telefono: "664-681-6856",
    servicios: ["Consulta veterinaria", "Hospital veterinario", "Peluquería canina y baño", "Vacunación y desparasitación"],
  }),

  chapultepets: vet("Hospital Veterinario Chapultepets", {
    direccion: "Calle 13 #1024, col. Libertad, Tijuana, B.C.",
    horario: "lunes a sábado de 8am a 11pm, domingos de 8am a 9pm",
    telefono: "664-210-5155",
    servicios: ["Consulta veterinaria", "Hospitalización", "Rayos X", "Fisioterapia", "Vacunación y desparasitación"],
  }),

  "mi-gran-amigo": vet("Mi Gran Amigo Hospital Animal", {
    direccion: "Calle Ing. Juan Ojeda Robles 205, Buena Vista, Tijuana, B.C.",
    horario: "lunes a sábado de 8am a 8pm, domingos de 10am a 4pm",
    telefono: "664-415-7990",
    servicios: ["Consulta veterinaria", "Hospitalización", "Tratamiento de infecciones como parvovirus", "Vacunación y desparasitación"],
  }),

  novavet: vet("NovaVet Clínica Veterinaria", {
    direccion: "Paseo del Centenario 10232-A, Zona Río, Tijuana, B.C.",
    horario: "lunes a sábado de 9am a 5pm, domingos cerrado",
    telefono: "664-645-6770",
    servicios: ["Consulta veterinaria", "Vacunación", "Cirugía y esterilización", "Limpieza dental", "Peluquería canina"],
  }),

  "vet-playas": vet("Vet Playas Veterinary Hospital", {
    direccion: "Paseo Estrella del Mar 919, Playas de Tijuana, Tijuana, B.C.",
    horario: "todos los días de 9am a 12 de la noche",
    telefono: "664-631-8716",
    servicios: ["Consulta veterinaria", "Hospital veterinario", "Limpieza dental", "Resonancia magnética", "Cirugía"],
    extra: "Atienden a muchos clientes de Estados Unidos.",
  }),
};
