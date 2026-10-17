#!/usr/bin/env bash
# Скачивает оцифрованную коробку игры (zakoldovka.com, 120 МБ) в source/pdf/ и
# создаёт Python-окружение для скриптов извлечения данных.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="https://zakoldovka.com/zchm/ZaklyatyeChernogoMaga_21.12.2020.zip"
TMP="$(mktemp -d)"
curl -L -o "$TMP/zchm.zip" "$URL"
unzip -q -o "$TMP/zchm.zip" -d "$TMP"
mkdir -p "$ROOT/source/pdf"
cp "$TMP"/Zaklyatye_Chernogo_maga_Cifrovaya_korobka/*.pdf "$TMP"/Zaklyatye_Chernogo_maga_Cifrovaya_korobka/*.jpg "$TMP"/Zaklyatye_Chernogo_maga_Cifrovaya_korobka/Readme.txt "$ROOT/source/pdf/"
rm -rf "$TMP"
if [ ! -x "$ROOT/tools/.venv/bin/python" ]; then
  python3 -m venv "$ROOT/tools/.venv"
  "$ROOT/tools/.venv/bin/pip" install -q pypdfium2 pillow
fi
echo "Готово: source/pdf/ заполнен, tools/.venv создан."
