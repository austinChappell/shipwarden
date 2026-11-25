import { describe, expect, it } from 'vitest';
import { columnIndex, csvField, decodeXml, parseSharedStrings, readXlsx, sheetsToText, XlsxError } from './xlsx';
import { makeZip, WORKBOOK_FILES } from './zip-fixture';

describe('readXlsx', () => {
    it('reads the sheets of a deflated workbook in their order', () => {
        const sheets = readXlsx(makeZip(WORKBOOK_FILES));
        expect(sheets).toEqual([
            { name: 'Sales & Costs', csv: 'Region,Total\n"North, east",1250.5\n"Say ""hi""",,TRUE' },
            { name: 'Notes', csv: ',a < b' }
        ]);
    });

    it('reads a stored workbook', () => {
        expect(readXlsx(makeZip(WORKBOOK_FILES, 0))[1]).toEqual({ name: 'Notes', csv: ',a < b' });
    });

    it('finds a sheet without relations by its number', () => {
        const files = { ...WORKBOOK_FILES };
        delete files['xl/_rels/workbook.xml.rels'];
        expect(readXlsx(makeZip(files)).map(sheet => sheet.name)).toEqual(['Sales & Costs', 'Notes']);
    });

    it('reads a workbook with namespace prefixes on the elements', () => {
        const prefixed = Object.fromEntries(
            Object.entries(WORKBOOK_FILES).map(([name, xml]) => [
                name,
                name.endsWith('.rels') ? xml : xml.replace(/<(\/?)(?=[a-zA-Z])(?!\?)/g, '<$1x:').replace(/r:id=/g, 'rel:id=')
            ])
        );
        expect(readXlsx(makeZip(prefixed)).map(sheet => sheet.csv)).toEqual(readXlsx(makeZip(WORKBOOK_FILES)).map(sheet => sheet.csv));
    });

    it('rejects a file that is not a zip file', () => {
        expect(() => readXlsx(Buffer.from('not a workbook'))).toThrow(XlsxError);
    });

    it('rejects a zip file without a workbook', () => {
        expect(() => readXlsx(makeZip({ 'word/document.xml': '<w/>' }))).toThrow('not a valid Excel workbook');
    });
});

describe('sheetsToText', () => {
    it('puts a heading line before each sheet', () => {
        expect(
            sheetsToText([
                { name: 'A', csv: '1,2' },
                { name: 'B', csv: '' }
            ])
        ).toBe('# Sheet: A\n1,2\n\n# Sheet: B\n(empty)');
    });
});

describe('xlsx helpers', () => {
    it('finds the column of a cell reference', () => {
        expect(columnIndex('A1')).toBe(0);
        expect(columnIndex('Z9')).toBe(25);
        expect(columnIndex('AB3')).toBe(27);
    });

    it('quotes CSV fields only when necessary', () => {
        expect(csvField('plain')).toBe('plain');
        expect(csvField('a,b')).toBe('"a,b"');
        expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    });

    it('decodes XML entities', () => {
        expect(decodeXml('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;&#x42;')).toBe('<a> & "b" \'c\' AB');
    });

    it('reads empty shared strings', () => {
        expect(parseSharedStrings('<sst><si/><si><t/></si><si><t>x</t></si></sst>')).toEqual(['', '', 'x']);
    });
});
