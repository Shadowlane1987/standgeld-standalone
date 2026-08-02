// CLI-Trockenlauf: prueft fuer einen Transport, ob der Motor Standgeld beantragen
// WUERDE - ohne einen Zuschlag zu speichern. Zeigt zusaetzlich die echte
// Grid-Struktur (Standzeit-/Referenzpreis-Elemente), damit die Erkennung
// nachvollziehbar wird.
//
// Nutzung:
//   node server/tools/dryRunStandgeld.js <transportnummer>
//
// Voraussetzung: Automations-Fenster ist offen, eingeloggt, "Zugewiesene
// Transporte" ist geoeffnet (gleiches Playwright-Profil wie beim Echtlauf).

const {
  dryRunStandgeldCheck,
} = require("../services/transporeonSurchargeAutomation");

async function main() {
  const transportNumber = String(process.argv[2] || "").trim();
  if (!transportNumber) {
    console.error("Bitte eine Transportnummer angeben.");
    console.error("Beispiel: node server/tools/dryRunStandgeld.js 1234567890");
    process.exit(1);
  }

  const result = await dryRunStandgeldCheck(transportNumber);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Fehler:", error?.message || error);
  process.exit(1);
});
