/** Vite gives the text of a file for an import with "?raw". */
declare module '*.md?raw' {
    const text: string;
    export default text;
}
