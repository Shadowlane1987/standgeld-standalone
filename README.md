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

## Deploy auf Render

1. Dieses Repository nach GitHub pushen.
2. In Render auf `New +` -> `Blueprint` klicken.
3. Das Repository `standgeld-standalone` auswaehlen.
4. Render liest automatisch `render.yaml` und erstellt den Web Service.
5. Nach dem Deploy die URL oeffnen und `/api/health` pruefen.

Falls du statt Blueprint den Web-Service manuell anlegen willst:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

### Wichtiger Hinweis zu gespeicherten Uploads

Damit hochgeladene Excel-Dateien (Importe, Entladezeitfenster-Fallback) nach
Neustarts und Deploys erhalten bleiben, muss ein persistenter Speicher genutzt
werden.

- Die App nutzt den Datenpfad aus `APP_DATA_DIR`.
- Ohne `APP_DATA_DIR` wird lokal standardmaessig `./data` verwendet.
- Auf Render sollte `APP_DATA_DIR=/var/data` gesetzt sein und ein Persistent
  Disk auf `/var/data` gemountet werden.

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
