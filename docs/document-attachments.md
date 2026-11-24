# Document attachments

The chat view takes PDF, Word, and spreadsheet files. ShipWarden converts each file to text (or to images) on the Mac
before the agent gets it. The agent gets the path of a text file in the prompt, so a long document does not go into the
terminal.

## Use

- Drop files on the chat view, or click the paperclip in the chat field and choose files.
- Each document shows as a chip in the chat field. A spinner shows while ShipWarden is converting the file. The remove
  button removes the document from the next prompt.
- The send button waits until all documents are converted.
- An image file (PNG, JPEG, GIF, or WebP) goes to the agent as an image, as a pasted image does.
- A file type that ShipWarden cannot convert shows an error above the chat field. The error names the supported types.

## Types

| Type | Extensions | Converter |
|---|---|---|
| Word and text documents | .docx, .doc, .rtf, .odt, .html, .htm | `textutil -convert txt -stdout` |
| PDF | .pdf | PDFKit, in a JXA script (`osascript -l JavaScript`) |
| Excel | .xlsx, .xlsm | A small zip and XML reader in the main process (`main/documents/xlsx.ts`) |
| Plain text | .csv, .tsv, .txt, .md | The file as it is |

ShipWarden does not convert old Excel files (.xls), Numbers, Pages, or Keynote files. Save them as .xlsx, .docx, or PDF
first.

### PDF

- The script reads the text of each page. A text with more than one page gets a "--- Page n ---" line before each page.
- A PDF with fewer than 16 letters and digits on each page (on average) has no text layer, for example a scan. The
  script then renders the first 5 pages to PNG images (1.5 times the PDF size, 1600 pixels wide at most). The chat gives
  them to the agent as image attachments, and the prompt says how many pages the PDF has.
- A PDF with a password shows an error.

### Excel

- Each sheet becomes CSV lines after a "# Sheet: name" line.
- A cell gives its stored value. ShipWarden does not apply number formats, so a date shows as its serial number. A
  formula shows its last result.
- The reader supports the zip methods "store" and "deflate". It does not read Zip64 files (larger than 4 GB).

## Limits

- The largest file is 50 MB.
- ShipWarden keeps the first 500,000 characters of a text. The chip of a longer document shows "Cut", a note under the
  chips says how much the agent gets, and the prompt tells the agent that the text is cut.
- A PDF without text gives the first 5 pages as images.
- A prompt can have 10 documents.

## Files

- Each conversion writes `<name>.txt` (or the page images) into its own folder in
  `~/Library/Application Support/ShipWarden/attachments`.
- ShipWarden removes the folders that are older than 7 days when it converts the next document.
- The prompt starts with a list of the documents and the paths of their text files, then the text of the user (see
  `documentPrompt` in `src/shared/documents.ts`).
