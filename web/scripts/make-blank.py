# Пустые шаблоны для новых офисных узлов: web/public/blank/blank.{docx,xlsx,pptx}.
# Новый узел открывается в Craft шаблоном под своим именем, и Save пишет в его формат.
# pip install python-docx openpyxl python-pptx && python3 web/scripts/make-blank.py web/public/blank
import sys
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Emu
out = sys.argv[1]
Document().save(f'{out}/blank.docx')
wb = Workbook(); wb.active.title = 'Sheet1'; wb.save(f'{out}/blank.xlsx')
p = Presentation(); p.slide_width, p.slide_height = Emu(12192000), Emu(6858000)
p.slides.add_slide(p.slide_layouts[0])  # титульный слайд, как у нового файла в PowerPoint
p.save(f'{out}/blank.pptx')
