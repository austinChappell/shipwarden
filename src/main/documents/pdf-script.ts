/**
 * A JavaScript for Automation (JXA) script that reads a PDF with PDFKit. macOS runs it with
 * `osascript -l JavaScript -e <script> <command> <pdf> [<folder> <pages>]`, so ShipWarden needs no native helper.
 *
 * Commands:
 * - `text <pdf>`: writes JSON `{ "pages": n, "texts": ["page 1 text", …] }`.
 * - `images <pdf> <folder> <pages>`: renders the first <pages> pages to `<folder>/page-<n>.png` and writes JSON
 *   `{ "pages": n, "files": ["…/page-1.png", …] }`.
 *
 * A PDF that PDFKit cannot open gives `{ "error": "open" }`. A locked PDF gives `{ "error": "locked" }`.
 */
export const PDF_SCRIPT = `
ObjC.import('PDFKit');
ObjC.import('AppKit');
function run(argv) {
    var command = argv[0];
    var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[1]));
    if (doc.isNil()) return JSON.stringify({ error: 'open' });
    if (doc.isLocked) return JSON.stringify({ error: 'locked' });
    var pages = Number(doc.pageCount);
    if (command === 'text') {
        var texts = [];
        for (var i = 0; i < pages; i++) {
            var value = doc.pageAtIndex(i).string;
            texts.push(value.isNil() ? '' : value.js);
        }
        return JSON.stringify({ pages: pages, texts: texts });
    }
    var folder = argv[2];
    var count = Math.min(pages, Number(argv[3]));
    var files = [];
    for (var j = 0; j < count; j++) {
        var page = doc.pageAtIndex(j);
        var box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
        // Render at 1.5 times the PDF size (108 dpi), with a maximum width of 1600 pixels.
        var scale = Math.min(1.5, 1600 / Math.max(1, box.size.width));
        var image = page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * scale, box.size.height * scale), $.kPDFDisplayBoxMediaBox);
        var bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
        var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
        var file = folder + '/page-' + (j + 1) + '.png';
        png.writeToFileAtomically(file, true);
        files.push(file);
    }
    return JSON.stringify({ pages: pages, files: files });
}
`;
