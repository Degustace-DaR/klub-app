# Zálohy

Sem GitHub Action (`.github/workflows/backup.yml`) jednou denně ukládá:

- **`db/klub-RRRR-MM-DD.json`** – celá databáze (Firestore), všechny kolekce.
  Formát je stejný jako ruční export v appce, takže se dá rovnou naimportovat:
  **Info → 📥 Import databáze (JSON)** (pozor: přepíše všechna data).
  Ve složce se drží 30 posledních dní + vždy záloha z 1. dne v měsíci;
  starší jsou pořád dohledatelné v historii gitu.

- **`photos/`** – zrcadlo fotek z Firebase Storage (`rum-photos/`, `cigar-photos/`).

## Obnova

**Celá databáze:** appka → Info → Import databáze → vyber poslední `db/klub-*.json`.

**Jen kus dat / ručně:** JSON je čitelný, dá se z něj vytáhnout konkrétní
záznam a vložit zpět přes Firestore konzoli.

**Fotky:** nahrát zpět do Firebase Storage (konzole → Skladování) do stejných
cest, nebo přes appku znovu přiřadit k rumu/doutníku.

## Ruční spuštění zálohy

GitHub → repo → **Akce** → *Záloha databáze* → **Spustit workflow**.
