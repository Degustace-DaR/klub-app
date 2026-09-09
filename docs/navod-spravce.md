# Návod – správce (Broněk, Libor)

Máš **všechno co běžný člen** (viz [navod-clen.md](navod-clen.md)) a navíc správu klubu.
Přihlašuješ se svým osobním PINem.

Skoro všechno „navíc" se ovládá **v detailu položky** (ťukneš na rum / doutník /
záznam) – tam přibydou tlačítka.

## Katalog (rumy i doutníky)

- **Nový rum / doutník** – tlačítko dole pod seznamem („+ Nový…, který ještě není v seznamu").
- **Upravit údaje** – v detailu tlačítko „✏️ Upravit údaje" (původ, cena, surovina,
  formát, síla…). Původ / surovina / síla jsou rozbalovací seznamy, ať nevznikají překlepy.
- **Fotka** – v detailu „📷 Vyfotit" / „🖼️ Z galerie". Po výběru si ořízneš výřez.
  U nahrané fotky je „✂️ Oříznout" a „Smazat fotku".
- **Smazat rum / doutník** – v detailu dole (červené).

## Humidor

Detail doutníku: **přidat nákup** (dokoupení), **fotka**, **smazat doutník**.
Zápis vykouření může kdokoli; upravit/smazat cizí záznam v logu jen ty.

## Účet klubu

Formulář **Přidat transakci** (datum, popis, částka, kategorie). U kategorie „nákup"
se částka bere jako výdaj. Existující transakci upravíš/smažeš ťuknutím na řádek.

## Wishlist

Přeuspořádání tažením za „⠿". U položky: **„✅ Koupeno → do katalogu"** (přesune ji
mezi rumy/doutníky) a **Smazat**.

## Termíny

- **+ Nové kolo** (vpravo u nadpisu) → zadáš navrhovaná data → „Vytvořit kolo".
- V detailu kola: **přidat další termín**, **Vybrat** finální termín, **Smazat kolo**.
- **Účastníci domlouvání** – seznam lidí, kterých se kolo týká („+ Přidat účastníka").

## Účast

**+ Nová účast** (datum, místo, kdo byl). Záznam se dá upravit i smazat.
Účast se také vytvoří automaticky, když v termínech vybereš datum.

## Klub

**Přidat člena** (jen jméno). Nový člen bude potřebovat vlastní PIN – ten přidá
super admin do zdroje appky.

## Info → nástroje

- **⬇️ Exportovat všechno do Excelu** – jednorázová tabulka pro sebe.
- **📥 Obnovit databázi ze zálohy (JSON)** – přepíše VŠECHNA data appky, na kterou
  se právě díváš. Používej jen pro obnovu ze zálohy nebo naplnění testovací appky.
  **Nikdy „jen tak" v ostré.**

## Na co si dát pozor

- Import databáze je nevratný – před ním raději udělej zálohu.
- Data se ukládají hned; nahoře probleskne „ukládám… / ✓ uloženo".
- Když appka hlásí „potřebuje živé propojení" → jsi offline, zkus obnovit stránku.
