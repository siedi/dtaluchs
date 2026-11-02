# DTA von der Steuerung holen, ohne laufendes Werkzeug

`luxtronik-holen.sh` holt die DTA-Datei einmal von der Luxtronik und legt sie in einen Ordner. Das Werkzeug liest diesen Ordner als `[import] source`. Gedacht für einen NAS oder Server, auf dem das Werkzeug nicht dauernd läuft. Läuft es dauernd, holt es die Datei selbst, eingestellt auf der Seite Import. Für Cron auf einem Rechner mit dem Werkzeug gibt es außerdem `dtaluchs fetch`.

Das Skript braucht nur `sh` und `curl`, zum Hochladen curl ab 7.55.0 (Header von stdin, `--header @-`). Getestet mit `bash` als `sh` (macOS), `dash` (`backend/tests/65_contrib_abruf_test.py`), BusyBox in Alpine 3.20 (von Hand, 2026-10-19) und an einer Steuerung mit DTA-Version 9003. Das Hochladen mit `sh` und `dash` gegen eine gespielte Instanz und gegen das Werkzeug selbst (`backend/tests/80_contrib_abruf_upload_test.py`); in BusyBox nur die neuen Zeilen der Shell, nicht der Upload (2026-10-23).

## Einrichten

1. Skript an einen festen Ort kopieren und ausführbar machen:

   ```sh
   chmod +x luxtronik-holen.sh
   ```

2. Zielordner anlegen. Das Skript legt ihn nicht selbst an, damit ein Tippfehler im Pfad als Fehler auffällt.
3. Einmal von Hand aufrufen, mit der Adresse der Steuerung und dem Zielordner:

   ```sh
   ./luxtronik-holen.sh 192.168.1.50 /pfad/zum/ordner
   ```

   Die Adresse ist ein Host oder eine IP, optional mit `:Port`, IPv6 in eckigen Klammern, ohne `http://` und ohne Pfad. Ohne Ausgabe und mit Code 0 liegt danach eine Datei `luxtronik_JJMMTT_HHMM.dta` im Ordner.
4. Eintrag für `crontab -e`, jede Stunde (warum, steht unter „Takt“):

   ```
   17 * * * * TZ=Europe/Berlin /pfad/zu/luxtronik-holen.sh 192.168.1.50 /pfad/zum/ordner
   ```

   Liegt `curl` nicht in `/usr/bin` oder `/bin`, braucht der Eintrag den vollen `PATH`, etwa `PATH=/opt/bin:/usr/bin:/bin` vor dem Aufruf: Cron sucht mit einem kurzen `PATH`.

   `TZ` bestimmt nur die Uhrzeit im Dateinamen. Das Werkzeug liest die Zeiten aus dem Inhalt der Datei. Ohne Zonendaten im System (`/usr/share/zoneinfo`, etwa Alpine ohne `tzdata`) gilt still UTC; dort wirkt die Angabe `TZ=CET-1CEST,M3.5.0,M10.5.0/3` (geprüft am 2026-10-19 in Alpine 3.20).
5. In der `dtaluchs.toml` des Werkzeugs:

   ```toml
   [import]
   source = "/pfad/zum/ordner"
   ```

## Auf eine Instanz hochladen

Läuft das Werkzeug woanders, etwa als gehostete Instanz, lädt das Skript jede neu gespeicherte Datei dorthin hoch. Es verbindet nur nach außen, im Heimnetz ist kein Port offen. Drei Umgebungsvariablen:

| Variable | Inhalt |
|---|---|
| `DTALUCHS_URL` | Basis-URL der Anlage, bei einer gehosteten Instanz mit ihrem Präfix, etwa `https://beispiel.de/a/7`. Ohne sie lädt das Skript nichts hoch. Ohne Zugangsdaten (`user:pass@`), sie stünden in der Liste der Prozesse |
| `DTALUCHS_TOKEN` | Anlagen-Token, geht als `Authorization: Bearer …` mit. Optional: das selbst betriebene Werkzeug hat keine Anmeldung |
| `DTALUCHS_WAIT_S` | Wartezeit je Anfrage an die Instanz in ganzen Sekunden, Vorgabe 60 |

Eintrag für `crontab -e`:

```
17 * * * * TZ=Europe/Berlin DTALUCHS_URL=https://beispiel.de/a/7 DTALUCHS_TOKEN=dtl_… /pfad/zu/luxtronik-holen.sh 192.168.1.50 /pfad/zum/ordner
```

Das Token steht damit in der Crontab: Wer sie lesen kann, kennt es. curl bekommt es über stdin, nicht als Argument, damit es nicht in der Liste der Prozesse steht.

Nach dem Speichern einer neuen Datei: `PUT <DTALUCHS_URL>/api/upload/<Name der Datei>` mit der Datei als Inhalt, danach `POST <DTALUCHS_URL>/api/import?trigger=upload`. Jede Antwort 2xx gilt als Erfolg, einer Weiterleitung folgt das Skript nicht. Anders als der Abruf von der Steuerung nutzt der Upload einen Proxy aus der Umgebung (`https_proxy` und andere).

Schlägt eins davon fehl, bleibt die Datei im Ordner, das Skript endet mit Code 1 und einer Zeile, und der Name steht in `.luxtronik-holen.offen` im Zielordner. Jeder weitere Lauf lädt alle Namen dort erneut hoch, auch wenn die Steuerung nichts Neues hat, und meldet einen Fehler damit jedes Mal. Erst nach dem angestoßenen Import ist die Liste weg. Ein Werkzeug, das eine Datei schon kennt, antwortet 200 statt 201 und legt sie nicht doppelt an. Gegen zwei Läufe zugleich ist die Liste nicht geschützt; bei einem Lauf je Stunde aus Cron kommt das nicht vor.

## Takt

Die Steuerung schreibt ihre Datei alle zwei Stunden neu, zu einer Minute, die von der Steuerung abhängt. Ein Aufruf alle zwei Stunden kann deshalb eine Sicherung verpassen, wenn er fast zeitgleich mit dem Wechsel kommt und die Uhren leicht gegeneinander laufen. Ein Aufruf jede Stunde holt jede Sicherung; dazwischen bringt er denselben Inhalt, den das Skript überspringt. Das ist eine Ableitung, nicht gemessen.

Jede Datei enthält die letzten 48 Stunden, eine verpasste Sicherung kostet also meist nichts. Hat die Steuerung aber einen leeren Puffer, ist alles seit dem letzten Abruf verloren.

## Was das Skript tut

| Schritt |
|---|
| `GET http://<Adresse>/NewProc`, bei 404 `GET http://<Adresse>/proclog`; nur HTTP, ohne Weiterleitung und ohne Proxy |
| Adresse geprüft: Host oder IP, Port 1 bis 65535, sonst Fehler ohne Abruf |
| Wartezeit 30 s, änderbar mit der Umgebungsvariablen `LUXTRONIK_WAIT_S`; höchstens 8 MiB |
| Nicht gespeichert wird eine Antwort ohne HTTP 200, eine leere, eine abgebrochene und eine HTML-Fehlerseite. Alles andere wird gespeichert, auch eine DTA-Version, die dtaluchs nicht liest; dann folgt ein Hinweis |
| Gleicher Inhalt wie die neueste Datei im Ordner, nach Name und nach Änderungszeit: nichts gespeichert, Code 0 |
| Name `luxtronik_JJMMTT_HHMM.dta` nach der Zeit des Abrufs, bei belegtem Namen `_2`, `_3` … |
| Erst eine Zwischendatei `.luxtronik-holen.<PID>.part` im Zielordner, dann unter dem Namen verlinkt. Das Werkzeug liest nur Dateien auf `.dta`. Zwei Aufrufe zugleich überschreiben sich nicht; nur auf einem Dateisystem ohne harte Links benennt das Skript um und ist dagegen nicht geschützt |

Das Skript löscht nichts. Ein Neuaufbau liest alle Partitionen aus den Quelldateien neu, Sätze ohne Quelldatei fehlen danach.

## Ausgabe und Codes

| Code | Bedeutung | Ausgabe |
|---|---|---|
| 0 | gespeichert oder unverändert | keine, damit Cron keine Mail schickt |
| 0 | gespeichert, aber dtaluchs liest die Datei nicht | eine Zeile auf stderr, `luxtronik-holen: Hinweis: gespeichert, aber dtaluchs liest diese Antwort nicht (Kennung 9001)`; einmal je neuem Inhalt |
| 1 | Fehler | eine Zeile auf stderr, etwa `luxtronik-holen: Abruf fehlgeschlagen: Steuerung 192.168.1.50 antwortet nicht (30 s)` |
| 1 | gespeichert, aber Hochladen oder Import gescheitert | eine Zeile auf stderr, etwa `luxtronik-holen: Hochladen von luxtronik_261023_1417.dta fehlgeschlagen: HTTP 401, Anlagen-Token abgelehnt (DTALUCHS_TOKEN prüfen)`; bei 404 `… Anlage unter <URL> nicht gefunden (DTALUCHS_URL prüfen)`, sonst HTTP-Status oder Grund der Verbindung |
| 1 | `DTALUCHS_URL` ohne `http://` oder `https://`, mit Leerzeichen, `?`, `#` oder `@`; `DTALUCHS_WAIT_S` keine ganze Zahl über 0; `DTALUCHS_TOKEN` mit Leerzeichen oder Zeilenumbruch | eine Zeile auf stderr, vor dem Abruf |
| 2 | falscher Aufruf | die Zeile `Aufruf: …` auf stderr |
