# Rum Klub — nasazení na vlastní web (GitHub + Firebase)

Appka je hotová (`index.html`), jen potřebuje propojit s vlastní databází (Firebase) a dát na veřejnou adresu (GitHub Pages). Trvá to cca 15–20 minut, jde to celé přes web (žádný terminál, žádný git).

Pozn. k budoucnu: appka je postavená tak, že později půjde snadno přidat i druhou sekci (např. doutníky) jako samostatnou sadu dat vedle rumů — proto se nemusíš bát pojmenování zamknout jen na rum.

Pozn. k souborům: appka je rozdělená do několika souborů, které patří k sobě a musí se nahrávat všechny společně:

| soubor | co je | pro ostrou appku | pro testovací appku |
|---|---|---|---|
| `index.html` | ostrá appka (jen kostra + Firebase konfigurace) | ✅ | — |
| `index-test.html` | testovací appka (jiný Firebase projekt, červený pruh) | — | ✅ |
| `style.css` | vzhled (sdílí obě) | ✅ | ✅ |
| `app.js` | veškerá logika appky (sdílí obě) | ✅ | ✅ |
| `seed-data.js` | výchozí data pro první naplnění databáze | — | ✅ |
| `logo.png`, `favicon.png` | obrázky | ✅ | ✅ |
| `manifest.json`, `sw.js`, `icon-*.png`, `apple-touch-icon.png` | PWA (instalace na plochu) | ✅ | ✅ |

## Krok 1 — Firestore databáze ve Firebase

1. Jdi na [console.firebase.google.com](https://console.firebase.google.com) a přihlas se svým Google účtem.
2. **Add project** → pojmenuj ho třeba `klub-app` (jméno projektu nemusí obsahovat "rum" — snadno se pak rozšíří) → dokonči založení (Google Analytics k tomu nepotřebuješ, můžeš vypnout).
3. V levém menu **Build → Firestore Database** → **Create database** → zvol režim **Production mode** → vyber lokaci (např. `eur3 (europe-west)`) → **Enable**.
4. V Firestore přejdi na záložku **Rules** a vlož tento obsah (nahradí to, co tam je):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

   Klikni **Publish**. Tohle znamená: appku smí číst/zapisovat kdokoli, kdo appku otevře (a appka se automaticky "anonymně" přihlásí — viz krok 2) — ne úplně kdokoli na internetu bez appky.

## Krok 2 — zapnout anonymní přihlašování

1. V levém menu **Build → Authentication** → **Get started**.
2. Záložka **Sign-in method** → vyber **Anonymous** → zapnout (Enable) → **Save**.

Díky tomu appka může používat databázi, aniž by po lidech chtěla heslo — funguje to potichu na pozadí.

## Krok 3 — získat konfiguraci a vložit ji do appky

1. V levém menu klikni na ozubené kolečko vedle **Project Overview** → **Project settings**.
2. Dole v sekci **Your apps** klikni na ikonu **`</>`** (Web).
3. Appku pojmenuj (např. `klub-web`), **Firebase Hosting nezaškrtávej** (nepotřebujeme, používáme GitHub Pages) → **Register app**.
4. Zobrazí se kód s objektem `firebaseConfig` — zkopíruj ty hodnoty (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId).
5. Otevři soubor `index.html` (třeba v Poznámkovém bloku), dole ve `<script>` bloku najdi:

   ```js
   const FIREBASE_CONFIG = {
     apiKey: "SEM_VLOZ_apiKey",
     ...
   };
   ```

   a nahraď hodnoty `"SEM_VLOZ_..."` těmi svými. Ulož soubor.

## Krok 4 — appka na GitHub Pages (bez terminálu)

1. Jdi na [github.com](https://github.com), přihlas se → vpravo nahoře **+** → **New repository**.
2. Název repozitáře např. `klub-app` (opět bez "rum", ať se to nemusí přejmenovávat) → **Public** → **Create repository**.
3. Na stránce repozitáře klikni **Add file → Upload files** → přetáhni tam **všechny** soubory appky: `index.html`, `style.css`, `app.js`, `logo.png`, `favicon.png`, `manifest.json`, `sw.js`, ikony (`icon-*.png`, `apple-touch-icon.png`) a klidně i tenhle `README-NASAZENI.md`. (Pokud chceš i testovací appku, přidej ještě `index-test.html` a `seed-data.js`.) → **Commit changes**. Důležité: musí být pohromadě, jinak se appka nenačte.
4. Jdi do **Settings** repozitáře → v levém menu **Pages**.
5. U **Source** vyber **Deploy from a branch**, branch **main**, složka **/ (root)** → **Save**.
6. Za chvíli (do 1–2 minut) se nahoře objeví veřejná adresa appky, něco jako:
   `https://tvoje-jmeno.github.io/klub-app/`

Tuhle adresu pošli Liborovi a ostatním — appka jim poběží v mobilu i na počítači, bez nutnosti mít cokoliv od Claude.

## Průběžný export dat

V appce v záložce **👥 Klub** je dole tlačítko **⬇️ Exportovat všechna data (Excel)** — kdykoliv jedním kliknutím stáhneš aktuální stav všech tabulek (Členové, Rumy, Hodnocení, Účet, Wishlist) jako `.xlsx` soubor. Data tedy nejsou nikdy uzamčená jen ve Firebase.

## Práce z více počítačů (přes Claude Code)

Appka se dál vyvíjí přes git — commity se pushují na GitHub (`Degustace-DaR/klub-app`, branch `main`), odkud si je GitHub Pages sama vezme. Na tomhle počítači žije pracovní složka na Google Disku (`G:\Můj disk\Claude\Appka\Rum Klub Web`), ale appka na Disku **nijak nezávisí** — je to jen git repozitář, který jde otevřít odkudkoli.

**Na druhém počítači (třeba doma):**

1. Nainstaluj Claude Code (desktop appka funguje i na Windows) a přihlas se **stejným účtem**.
2. Stáhni si repozitář do libovolné složky (nemusí to být Google Disk):
   ```bash
   git clone https://github.com/Degustace-DaR/klub-app.git
   ```
3. V Claude Code otevři tu složku a založ nové vlákno — pracuje se úplně stejně jako tady.
4. **Před každou prací na kterémkoli počítači** dej `git pull`, ať máš nejnovější stav (noční záloha i práce z druhého PC se totiž průběžně pushuje do stejného repa).

Poznámky:

- Tahle konkrétní konverzace (historie rozhodnutí, kontext) je navázaná jen na tenhle počítač a tuhle složku — na druhém PC se needotáhne. Podstatné věci ale nese samotný git: `git log`, kód a komentáře v něm.
- Google Disk používej nanejvýš jako pohodlné úložiště téhle jedné pracovní složky — ne jako náhradu za `git pull`/`push`. Synchronizace Disku a gitu (zvlášť `.git` vnitřek) se občas perou o stejné soubory.
- Když budeš pracovat na obou počítačích souběžně, hlídej si `git pull --rebase origin main` před vlastním `push`, ať nedojde ke konfliktu.

## Když něco nefunguje

- Appka ukazuje "Appka ještě není nastavená" → v `index.html` zůstaly nevyplněné `SEM_VLOZ_...` hodnoty.
- Appka ukazuje "offline" i po vyplnění konfigurace → zkontroluj, že jsi v kroku 2 zapnul Anonymous přihlašování a v kroku 1 publikoval pravidla.
- Po nahrání nové verze na GitHub appka na staré adrese nereaguje → dej v prohlížeči tvrdý refresh (Ctrl+F5), GitHub Pages si stránku chvíli cachuje.
- Appka je bílá / rozbitá po nahrání → nejspíš chybí některý ze souborů (`style.css`, `app.js`, `logo.png`…). Musí být nahrané všechny a ve stejné složce jako `index.html`.
