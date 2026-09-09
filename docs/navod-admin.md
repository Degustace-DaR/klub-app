# Návod – super admin

Přihlášení PINem `20262026` (kód je v `index.html`, klidně si ho změň – viz níže).
Super admin **nemá jméno** – v „Přehledu změn" je vedený jako „Admin", proto na
běžnou práci používej radši svůj osobní účet (Broněk / Libor).

Máš **všechno co správce** (viz [navod-spravce.md](navod-spravce.md)) a navíc:

## Info → nástroje navíc

### Zálohy a obnova
- **⬇️ Stáhnout poslední noční zálohu (JSON)** – vytáhne z GitHubu nejnovější
  automatickou zálohu do počítače. Tímhle souborem se obnovuje databáze.
- **📦 Stáhnout vše (ZIP)** – kód + všechny zálohy + fotky v jednom souboru.
  Sem tam si ho ulož mimo GitHub (na disk / jiný cloud).

### Export dat
- **🗄️ Ruční export databáze (JSON)** – když chceš zálohu hned teď.

### Údržba a kontrola
- **📋 Přehled změn** – kdo, co a kdy v appce udělal.
- **🔎 Zkontrolovat podobné názvy původu / doutníky** – najde podezřele podobné
  zápisy (překlepy) a nabídne je sloučit.

## Hodnocení za kohokoli

V „Hodnotit" můžeš vybrat, **za koho** zapisuješ, a upravit i **cizí** hodnocení
(běžný člen i správce jen svoje).

## Automatická záloha

Každou noc běží na GitHubu úloha, která uloží celou databázi + fotky do složky
`backups/`. Drží se 30 posledních dní + vždy 1. den v měsíci. Nemusíš nic dělat.
Ruční spuštění: GitHub → repo `Degustace-DaR/klub-app` → Akce → „Záloha databáze"
→ Spustit workflow.

## Změna PINů

PINy jsou ve zdroji zahašované (nejsou čitelné). Změna:
1. otevři appku, v konzoli prohlížeče (F12) napiš `await pinHash("novy-pin")`
2. výsledek (dlouhý řetězec) vlož do `index.html` za `APP_PIN_HASH`
   (a případně i do `index-test.html`)
3. commitni a pushni; zvyš číslo `?v=` u `style.css` a `app.js` v obou souborech

Seznam všech PINů si drž bokem (heslový manažer) – appka ho nikde nezobrazuje.

## Bezpečnost (rozpracované)

- Appka má **Firebase App Check** (reCAPTCHA) – zatím v monitorovacím režimu.
  Až se potvrdí, že legitimní provoz prochází, zapne se vynucení + zpřísní se
  pravidla databáze. Do té doby je databáze technicky přístupná i mimo appku.
- Detaily: `memory/security.md` v repu.
