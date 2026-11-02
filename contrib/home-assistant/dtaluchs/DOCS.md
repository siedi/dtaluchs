# DTA-Luchs in Home Assistant

DTA-Luchs läuft als App (früher „Add-on“) unter Home Assistant OS, also auch auf Home Assistant Green. Home Assistant Container kennt keine Apps; dort läuft DTA-Luchs als eigener Container nach `compose.yaml` im Repository.

## Installation

Die Bezeichnungen stehen hier englisch, wie in der Doku von Home Assistant (https://contributors.home-assistant.io/apps/guides/repository/):

1. **Settings** > **Apps** > **Install app**, im Menü oben rechts **Repositories**.
2. `https://github.com/siedi/dtaluchs` eintragen und **Add** wählen. Oder direkt über den Link: [Repository in Home Assistant hinzufügen](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fsiedi%2Fdtaluchs).
3. Die App **DTA-Luchs** im Store installieren, starten, **Show in sidebar** einschalten.

Home Assistant baut die App beim Installieren auf dem Gerät. Sie baut auf dem Image `ghcr.io/siedi/dtaluchs` in der Version aus `config.yaml` auf.

Nach der Installation ist der Watchdog aus. Wer ihn will, schaltet ihn auf der Seite der App ein.

## Daten

Die App hat keinen Zugriff auf Ordner von Home Assistant. Die Daten kommen auf zwei Wegen:

- **Abruf von der Steuerung:** auf der Seite **Import** in der Zeile **Abruf** die Adresse der Steuerung eintragen und den Abruf einschalten. Die App holt die DTA nach jeder Sicherung der Steuerung.
- **Hochladen:** vorhandene DTA-Dateien auf die Seite **Import** ziehen.

Der Bestand liegt im Datenordner der App und ist Teil jeder Sicherung von Home Assistant. Während einer Sicherung hält Home Assistant die App kurz an.

## Optionen

| Option | Bedeutung |
|---|---|
| Zeitzone der Anlage | IANA-Name, etwa `Europe/Berlin`. Leer: die Zeitzone von Home Assistant. Alle Zeiten und die Tagesgrenzen der Kennzahlen gelten in ihr |
| Speicher für Abfragen (MB) | Grenze je DuckDB-Instanz. Auf einem Gerät mit wenig Speicher herabsetzen |

Nach einer Änderung die App neu starten.

## Zugang

Die Oberfläche ist nur über Home Assistant erreichbar; die App öffnet keinen Port. Im Seitenmenü sehen sie nur Administratoren, denn wer sie öffnet, kann die Adresse des Abrufs ändern und Dateien hochladen.

## Grenzen

- Auf einem Rechner mit x86-64 braucht die CPU die Befehlssätze von x86-64-v3, darunter AVX2. Fehlt einer, startet die App nicht und nennt im Log die fehlenden. In einer VM unter Proxmox den CPU-Typ `host` oder `x86-64-v3` wählen.
