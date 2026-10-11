"""Tests for the reusable XLSX/PDF project-file reader."""
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

from src.backend.services.source_files import discover_source_files, read_source_file


class SourceFileReaderTests(unittest.TestCase):
    def test_reads_any_xlsx_with_sheet_headers_rows_and_locations(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'downloaded-source.xlsx'
            book = Workbook()
            sheet = book.active
            sheet.title = 'Survey'
            sheet.append(['ID', 'Comment', 'Comment'])
            sheet.append(['C-1', 'First comment', 'Second field'])
            sheet.append([None, None, None])
            second = book.create_sheet('Other tab')
            second.append(['Value'])
            second.append([8])
            book.save(path)

            document = read_source_file(path)
            self.assertEqual(document['format'], 'xlsx')
            self.assertEqual([sheet['name'] for sheet in document['sheets']], ['Survey', 'Other tab'])
            survey = document['sheets'][0]
            self.assertEqual(survey['columns'], ['ID', 'Comment', 'Comment__2'])
            self.assertEqual(survey['records'][0]['row'], 2)
            self.assertEqual(survey['records'][0]['fields']['Comment__2'], 'Second field')
            self.assertEqual(survey['rows'][2]['row'], 3)

    def test_reads_any_text_pdf_as_page_records(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'downloaded-catalog.PDF'
            document = pymupdf.open()
            page = document.new_page()
            page.insert_text((72, 72), 'A source catalog page')
            document.save(path)
            document.close()

            result = read_source_file(path)
            self.assertEqual(result['format'], 'pdf')
            self.assertEqual(result['pages'][0]['page'], 1)
            self.assertIn('source catalog page', result['pages'][0]['text'])
            self.assertEqual(result['warnings'], [])

    def test_discovers_project_xlsx_and_pdf_files_case_insensitively(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'study.xlsx').write_bytes(b'placeholder')
            (root / 'catalog.PDF').write_bytes(b'placeholder')
            (root / 'notes.txt').write_text('not a supported source')
            self.assertEqual(discover_source_files(root), [
                {'name': 'catalog.PDF', 'format': 'pdf', 'available': True},
                {'name': 'study.xlsx', 'format': 'xlsx', 'available': True},
            ])

    def test_rejects_unsupported_formats(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'source.csv'
            path.write_text('id,text\n1,hello')
            with self.assertRaisesRegex(ValueError, 'xlsx and .pdf'):
                read_source_file(path)


if __name__ == '__main__':
    unittest.main()
