/**
 * `?raw` imports.
 *
 * Vite and Bun both resolve `foo.json?raw` to the file's text, which is how
 * the condition contract is read straight from `shared/`. Declaring it
 * here keeps the committed schema the single source of truth instead of
 * being copied into a TypeScript file that can drift.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
