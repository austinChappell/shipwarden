/** The smallest and the largest zoom of the image viewer. 1 is 100%. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;

/** The zoom steps of the image viewer. A step in or out goes to the next value in this list. */
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** Returns the next zoom step after `zoom`. `direction` is 1 to zoom in and -1 to zoom out. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
    if (direction > 0) {
        return STEPS.find(step => step > zoom + 1e-6) ?? MAX_ZOOM;
    }
    return [...STEPS].reverse().find(step => step < zoom - 1e-6) ?? MIN_ZOOM;
}

/** Returns the zoom that fits an image in a box. The fit zoom is never larger than 1, so a small image keeps its size. */
export function fitZoom(width: number, height: number, boxWidth: number, boxHeight: number): number {
    if (width <= 0 || height <= 0 || boxWidth <= 0 || boxHeight <= 0) {
        return 1;
    }
    return Math.min(1, boxWidth / width, boxHeight / height);
}

/** Keeps a zoom between the limits. */
export function clampZoom(zoom: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
