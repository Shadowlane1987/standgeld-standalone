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
