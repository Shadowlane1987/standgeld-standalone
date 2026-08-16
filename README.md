# Standgeld Standalone

Eigenständige Standgeld-App (ohne Watchdog-Abhängigkeit).

## Start

1. Abhängigkeiten installieren:
   npm install
2. Umgebungsdatei anlegen:
   copy .env.example .env
3. Development starten:
   npm run dev

Danach ist die App unter http://localhost:3100 erreichbar.

## Features (Basis)

- UI für Regeln (Freiminuten, Takt, Preis)
- API-Endpunkt `POST /api/sixfold/standgeld`
- Ergebnis-Tabelle mit Standzeitberechnung
- Platzhalterfelder für Sixfold-URL und Session-Daten

## Lokaler Betrieb (Portable)

Die App laeuft vollstaendig lokal auf dem eigenen PC - kein Cloud-Hosting noetig.

1. `Standgeld-App starten.cmd` (bzw. `Fernverkehr starten.cmd`) per Doppelklick
   starten. Beim ersten Start werden die Node-Komponenten installiert.
2. Der Motor startet auf http://localhost:3100 und der Browser oeffnet sich
   automatisch.
3. Beim Start wird der Datenordner automatisch nach `backups/` gesichert
   (max. 30 Tagesbackups).

Zum Beenden das minimierte Server-Fenster schliessen.

### Wichtiger Hinweis zu gespeicherten Uploads

Damit hochgeladene Excel-Dateien (Importe, Entladezeitfenster-Fallback) nach
Neustarts und Deploys erhalten bleiben, muss ein persistenter Speicher genutzt
werden.

- Die App nutzt den Datenpfad aus `APP_DATA_DIR`.
- Ohne `APP_DATA_DIR` wird lokal standardmaessig `./data` verwendet.

Verwendete Persistenzpfade:

- `${APP_DATA_DIR}/imports/files`
- `${APP_DATA_DIR}/imports/meta`
- `${APP_DATA_DIR}/imports/unload_windows.xlsx`
- `${APP_DATA_DIR}/captures/transporeon_export.xlsx` (Default-Pfad fuer Export)

## API Payload (Beispiel)

```json
{
  "url": "https://app.sixfold.com/companies/.../fleet/.../timeline",
  "sessionToken": "...",
  "rules": {
    "freeMinutes": 120,
    "unitMinutes": 30,
    "unitPrice": 30,
    "thresholdEur": 30,
    "capEur": 650
  },
  "stops": [
    {
      "transport_number": "002394201",
      "type": "UNLOAD",
      "booking_location": "DE_BAR_Bargteheide",
      "arrival_time": "2026-07-07T00:01:00.000Z",
      "departure_time": "2026-07-07T07:26:00.000Z",
      "timeslot_begin": "2026-07-07T08:30:00.000Z"
    }
  ]
}
```
