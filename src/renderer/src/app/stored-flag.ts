/** Reads a stored on/off value. A missing or wrong value gives `fallback`. */
export function readFlag(raw: string | null, fallback: boolean): boolean {
    return fallback ? raw !== 'false' : raw === 'true';
}
