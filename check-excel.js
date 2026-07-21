const transporeon = require("./server/normalize/transporeonExport.js");
const XLSX = require("xlsx");

const wb = XLSX.readFile("data/captures/transporeon_export.xlsx");
const wsName = wb.SheetNames[0];
const ws = wb.Sheets[wsName];
const transports = transporeon.parseTransporeonExport(ws);

if (transports.length > 0) {
  const t = transports[0];
  console.log("=== Excel Transport Felder ===");
  console.log(Object.keys(t).sort());

  console.log("\n=== Erstes Transport ===");
  console.log("transport_number:", t.transport_number);
  console.log("vehicle_registration:", t.vehicle_registration);
  console.log("shipper_transport_number:", t.shipper_transport_number);

  if (t.stops && t.stops.length > 0) {
    console.log("\n=== Stop Felder ===");
    const s = t.stops[0];
    console.log(Object.keys(s).sort());

    console.log("\n=== Erster Stop ===");
    console.log(JSON.stringify(s, null, 2));
  }
}
