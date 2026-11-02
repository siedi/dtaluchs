#!/bin/sh
# Fetch the DTA file from a Luxtronik control into a folder that dtaluchs reads as [import] source.
# POSIX sh and curl only, for cron on a NAS,
# usage in README.md next to this file. Silent on success; on failure one line on stderr, code 1.
#
#   luxtronik-holen.sh <address> <folder>
#   address: host or IP of the control, optionally with :port, IPv6 in brackets
#
# With DTALUCHS_URL set, a newly saved file also goes to that instance: PUT <url>/api/upload/<name>, then
# POST <url>/api/import?trigger=upload. DTALUCHS_TOKEN, if set, goes along as Bearer token. Only outgoing connections.

set -u

# Versions dtaluchs reads; keep equal to SUPPORTED_VERSIONS in backend/src/dtaluchs/core/dta/reader.py
# (checked by backend/tests/65_contrib_abruf_test.py). Other answers are kept too, with a note.
VERSIONS="8209 9003"
WAIT_S=${LUXTRONIK_WAIT_S:-30}
MAX_BYTES=8388608
# Base URL of the plant; for a hosted instance with its prefix /a/<id>. Empty: no upload, as before.
TARGET=${DTALUCHS_URL:-}
while case $TARGET in */) true ;; *) false ;; esac; do
    TARGET=${TARGET%/}
done
UPLOAD_WAIT_S=${DTALUCHS_WAIT_S:-60}

fail() {
    echo "luxtronik-holen: $*" >&2
    exit 1
}

if [ "$#" -ne 2 ]; then
    echo "Aufruf: luxtronik-holen.sh <Adresse der Steuerung> <Zielordner>" >&2
    exit 2
fi
address=$1
folder=$2

bad_address() {
    fail "Adresse \"$address\" ist kein Host oder IP mit optionalem :Port (1 bis 65535)"
}
case $address in
    '' | *[!]A-Za-z0-9.:[-]*) bad_address ;;
    \[*\]) port= ;;
    \[*\]:) bad_address ;;
    \[*\]:*) port=${address##*]:} ;;
    *\[* | *\]* | *:*:* | *:) bad_address ;;
    *:*) port=${address##*:} ;;
    *) port= ;;
esac
case $port in
    *[!0-9]* | ??????*) bad_address ;;
esac
if [ -n "$port" ] && { [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; }; then
    bad_address
fi
[ -d "$folder" ] || fail "Zielordner $folder fehlt"
[ -w "$folder" ] || fail "Zielordner $folder ist nicht beschreibbar"
command -v curl >/dev/null || fail "curl nicht gefunden (PATH=$PATH)"
# Checked before the fetch, so a wrong setting does not wait for the control first.
case $TARGET in
    '') ;;
    # Not echoed: the part before @ would be a password.
    *@*) fail "DTALUCHS_URL enthält Zugangsdaten (@); das Anlagen-Token gehört in DTALUCHS_TOKEN" ;;
    *[[:space:]?#]*) fail "DTALUCHS_URL \"$DTALUCHS_URL\" enthält Leerzeichen, ? oder #" ;;
    http://?* | https://?*) ;;
    *) fail "DTALUCHS_URL \"$DTALUCHS_URL\" beginnt nicht mit http:// oder https://" ;;
esac
if [ -n "$TARGET" ]; then
    case $UPLOAD_WAIT_S in
        '' | *[!0-9]* | 0) fail "DTALUCHS_WAIT_S \"$UPLOAD_WAIT_S\" ist keine ganze Zahl von Sekunden über 0" ;;
    esac
    # A line break would add a header of its own.
    case ${DTALUCHS_TOKEN:-} in
        *[![:graph:]]*) fail "DTALUCHS_TOKEN enthält Leerzeichen oder einen Zeilenumbruch" ;;
    esac
fi

part="$folder/.luxtronik-holen.$$.part"
trap 'rm -f "$part"' EXIT
trap 'exit 1' HUP INT TERM

# Prints the HTTP status; curl's exit code tells connection errors apart.
get() {
    curl --silent --globoff --noproxy '*' --max-time "$WAIT_S" --max-filesize "$MAX_BYTES" \
        --output "$part" --write-out '%{http_code}' "http://$address$1"
}

path=/NewProc
status=$(get "$path")
code=$?
if [ "$code" -eq 0 ] && [ "$status" = 404 ]; then
    path=/proclog
    status=$(get "$path")
    code=$?
fi
case $code in
    0) ;;
    6) fail "Abruf fehlgeschlagen: Adresse $address nicht auflösbar" ;;
    7) fail "Abruf fehlgeschlagen: Steuerung $address nimmt keine Verbindung an" ;;
    28) fail "Abruf fehlgeschlagen: Steuerung $address antwortet nicht (${WAIT_S} s)" ;;
    63) fail "Abruf fehlgeschlagen: Antwort größer als $MAX_BYTES Bytes" ;;
    18) fail "Abruf fehlgeschlagen: Antwort unter $path abgebrochen" ;;
    23) fail "Abruf fehlgeschlagen: Schreiben nach $folder nicht möglich" ;;
    *) fail "Abruf fehlgeschlagen: curl endete mit Code $code" ;;
esac
if [ "$status" = 404 ]; then
    fail "Abruf fehlgeschlagen: HTTP 404 unter /NewProc und /proclog"
fi
[ "$status" = 200 ] || fail "Abruf fehlgeschlagen: HTTP $status unter $path"
[ -s "$part" ] || fail "Abruf fehlgeschlagen: Antwort unter $path ist leer"
# curl before 8.4 checks --max-filesize only against an announced Content-Length.
size=$(wc -c <"$part")
[ "$((size))" -le "$MAX_BYTES" ] || fail "Abruf fehlgeschlagen: Antwort größer als $MAX_BYTES Bytes"

# First four bytes, little-endian; od -tu4 would use the byte order of the NAS.
set -- $(od -An -tu1 -N4 "$part")
version=
[ "$#" -eq 4 ] && version=$(($1 + $2 * 256 + $3 * 65536 + $4 * 16777216))
case " $VERSIONS " in
    *" $version "*) note= ;;
    *)
        # Same test as is_html in core/dta/reader.py, bytes only (LC_ALL=C) so tr and grep accept any input.
        if dd if="$part" bs=256 count=1 2>/dev/null | LC_ALL=C tr -d ' \t\r\n' | LC_ALL=C tr 'A-Z' 'a-z' |
            LC_ALL=C grep -q -e '^<html' -e '^<!doctypehtml'; then
            fail "Abruf fehlgeschlagen: Antwort ist eine HTML-Seite, keine DTA"
        fi
        note="Hinweis: gespeichert, aber dtaluchs liest diese Antwort nicht (Kennung ${version:-zu kurz})"
        ;;
esac

# The control replaces its file every two hours; a call in between gets the same content again.
# Newest by name is the last fetch, newest by time catches files named otherwise.
same=
for newest in "$(LC_ALL=C ls "$folder"/luxtronik_*.dta 2>/dev/null | tail -n 1)" \
    "$(ls -t "$folder"/luxtronik_*.dta 2>/dev/null | head -n 1)"; do
    if [ -n "$newest" ] && cmp -s "$part" "$newest"; then
        same=yes
        break
    fi
done

if [ -z "$same" ]; then
    # ln fails if the name is taken, so two runs at once never overwrite each other.
    base="$folder/luxtronik_$(date +%y%m%d_%H%M)"
    target="$base.dta"
    n=2
    until ln "$part" "$target" 2>/dev/null; do
        if [ ! -e "$target" ]; then
            # No hard links on this file system: mv, which is not safe against a second run at once.
            mv "$part" "$target" || fail "Speichern fehlgeschlagen: $target"
            break
        fi
        target="${base}_$n.dta"
        n=$((n + 1))
    done
    [ -z "$note" ] || echo "luxtronik-holen: $note" >&2
fi
[ -n "$TARGET" ] || exit 0

# Names not yet at the instance, one per line; gone only once the import was asked for. A failed upload is tried again on
# every run, also when the control has nothing new, so cron reports it each time.
pending="$folder/.luxtronik-holen.offen"
[ -z "$same" ] && echo "${target##*/}" >>"$pending"
[ -s "$pending" ] || exit 0

# Prints the HTTP status. The token goes to curl on stdin, not as an argument that ps would show.
send() {
    method=$1
    url=$2
    shift 2
    if [ -n "${DTALUCHS_TOKEN:-}" ]; then
        printf 'Authorization: Bearer %s\n' "$DTALUCHS_TOKEN"
    fi | curl --silent --globoff --max-time "$UPLOAD_WAIT_S" --request "$method" --header @- \
        --output /dev/null --write-out '%{http_code}' "$@" "$url"
}

# One line per failure; the file stays in the folder and in the list.
sent() {
    code=$1
    status=$2
    what=$3
    case $code in
        0) ;;
        6) fail "$what fehlgeschlagen: Adresse in DTALUCHS_URL nicht auflösbar ($TARGET)" ;;
        7) fail "$what fehlgeschlagen: $TARGET nimmt keine Verbindung an" ;;
        28) fail "$what fehlgeschlagen: $TARGET antwortet nicht (${UPLOAD_WAIT_S} s)" ;;
        35 | 51 | 58 | 60) fail "$what fehlgeschlagen: TLS-Verbindung zu $TARGET gescheitert (curl $code)" ;;
        *) fail "$what fehlgeschlagen: curl endete mit Code $code" ;;
    esac
    case $status in
        2??) ;;
        3??) fail "$what fehlgeschlagen: HTTP $status, Weiterleitung von $TARGET (DTALUCHS_URL auf die Zieladresse setzen, etwa https://)" ;;
        401) fail "$what fehlgeschlagen: HTTP 401, Anlagen-Token abgelehnt (DTALUCHS_TOKEN prüfen)" ;;
        404) fail "$what fehlgeschlagen: HTTP 404, Anlage unter $TARGET nicht gefunden (DTALUCHS_URL prüfen)" ;;
        *) fail "$what fehlgeschlagen: HTTP $status von $TARGET" ;;
    esac
}

# A name sent before a failed import goes again; the instance answers 200 for content it knows.
while read -r name; do
    [ -f "$folder/$name" ] || continue
    status=$(send PUT "$TARGET/api/upload/$name" --upload-file "$folder/$name")
    sent $? "$status" "Hochladen von $name"
done <"$pending"
status=$(send POST "$TARGET/api/import?trigger=upload" --data-binary '')
sent $? "$status" "Import anstoßen"
rm -f "$pending"
