const loader = require("./server/normalize/transporeonExport.js");
const transports = loader.loadTransporeonExport(
  "data/captures/transporeon_export.xlsx",
);

if (transports.length > 0) {
  console.log("=== ERSTES TRANSPORT ===");
  const t = transports[0];
  console.log("\nFelder:", Object.keys(t).sort());
  console.log("\n=== VALUES ===");
  Object.entries(t).forEach(([k, v]) => {
    const val = Array.isArray(v)
      ? `[${v.length} items]`
      : typeof v === "object"
        ? JSON.stringify(v).substring(0, 40)
        : String(v).substring(0, 60);
    console.log(`  ${k}: ${val}`);
  });

  // Schaue nach möglichen Kennzeichen-Feldern
  console.log("\n=== KENNZEICHEN-FELDER ===");
  Object.keys(t).forEach((key) => {
    if (
      key.toLowerCase().includes("kenn") ||
      key.toLowerCase().includes("license") ||
      key.toLowerCase().includes("plate") ||
      key.toLowerCase().includes("fahrzeug") ||
      key.toLowerCase().includes("vehicle")
    ) {
      console.log(`  ${key}: ${t[key]}`);
    }
  });

  // Zeige auch die stops
  if (t.stops && t.stops.length > 0) {
    console.log("\n=== ERSTER STOP ===");
    const s = t.stops[0];
    console.log("Stop Felder:", Object.keys(s).sort());
    Object.entries(s).forEach(([k, v]) => {
      const val =
        typeof v === "object"
          ? JSON.stringify(v).substring(0, 40)
          : String(v).substring(0, 60);
      console.log(`  ${k}: ${val}`);
    });
  }
}
