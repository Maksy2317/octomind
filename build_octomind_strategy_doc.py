from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUT = Path(__file__).with_name("OctoMind_Marketing_Strategy_UA.docx")

BLUE = RGBColor(46, 116, 181)
DARK_BLUE = RGBColor(31, 77, 120)
INK = RGBColor(30, 30, 30)
MUTED = RGBColor(88, 88, 88)
LIGHT_FILL = "F2F4F7"
PALE_BLUE = "E8EEF5"


def set_run(run, size=None, bold=None, color=None, italic=None):
    run.font.name = "Calibri"
    run._element.rPr.rFonts.set(qn("w:ascii"), "Calibri")
    run._element.rPr.rFonts.set(qn("w:hAnsi"), "Calibri")
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color is not None:
        run.font.color.rgb = color


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    node = tc_pr.find(qn("w:shd"))
    if node is None:
        node = OxmlElement("w:shd")
        tc_pr.append(node)
    node.set(qn("w:fill"), fill)


def cell_margins(cell, top=80, start=120, bottom=80, end=120):
    tc_pr = cell._tc.get_or_add_tcPr()
    mar = tc_pr.first_child_found_in("w:tcMar")
    if mar is None:
        mar = OxmlElement("w:tcMar")
        tc_pr.append(mar)
    for name, value in {"top": top, "start": start, "bottom": bottom, "end": end}.items():
        node = mar.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_width(table, widths):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tbl = table._tbl
    tbl_pr = tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:type"), "dxa")
    tbl_w.set(qn("w:w"), str(sum(widths)))
    grid = tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for i, cell in enumerate(row.cells):
            cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:type"), "dxa")
            tc_w.set(qn("w:w"), str(widths[i]))


def style_doc(doc):
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.font.color.rgb = INK
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10

    for name, size, color, before, after in [
        ("Heading 1", 16, BLUE, 16, 8),
        ("Heading 2", 13, BLUE, 12, 6),
        ("Heading 3", 12, DARK_BLUE, 8, 4),
    ]:
        st = doc.styles[name]
        st.font.name = "Calibri"
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = color
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True


def add_header_footer(doc):
    header = doc.sections[0].header.paragraphs[0]
    header.text = "OctoMind: актуальна маркетингова стратегія"
    set_run(header.runs[0], 9, color=MUTED)
    footer = doc.sections[0].footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_run(footer.add_run("Робочий документ | липень 2026"), 9, color=MUTED)


def add_title(doc):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    set_run(p.add_run("МАРКЕТИНГОВА СТРАТЕГІЯ OCTOMIND"), 22, bold=True)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(14)
    set_run(p.add_run("Актуальний аналіз продукту, позиціонування, ЦА, воронки й запуску реклами"), 14, color=MUTED)

    for label, value in [
        ("Дата", "9 липня 2026"),
        ("Основа", "live-сайт OctoMind + актуальний код у репозиторії"),
        ("Ключове виправлення", "стратегія більше не базується на старому MVP з відео/каруселями/субтитрами"),
        ("Актуальні тарифи", "Free $0, Pro $12/міс, Business $29/міс"),
    ]:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(2)
        set_run(p.add_run(label + ": "), 11, bold=True)
        set_run(p.add_run(value), 11)

    rule = doc.add_paragraph()
    rule.paragraph_format.space_before = Pt(10)
    rule.paragraph_format.space_after = Pt(12)
    p_pr = rule._p.get_or_add_pPr()
    p_bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "8")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "2E74B5")
    p_bdr.append(bottom)
    p_pr.append(p_bdr)


def bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(4)
        p.add_run(item)


def numbers(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Number")
        p.paragraph_format.space_after = Pt(4)
        p.add_run(item)


def table(doc, headers, rows, widths, header_fill=LIGHT_FILL):
    tbl = doc.add_table(rows=1, cols=len(headers))
    tbl.style = "Table Grid"
    for i, text in enumerate(headers):
        cell = tbl.rows[0].cells[i]
        cell.text = text
        shade(cell, header_fill)
        for p in cell.paragraphs:
            for r in p.runs:
                set_run(r, 10, bold=True)
    for row in rows:
        cells = tbl.add_row().cells
        for i, text in enumerate(row):
            cells[i].text = text
            for p in cells[i].paragraphs:
                p.paragraph_format.space_after = Pt(0)
                for r in p.runs:
                    set_run(r, 9.5)
    set_table_width(tbl, widths)
    doc.add_paragraph()


def callout(doc, title, body):
    tbl = doc.add_table(rows=1, cols=1)
    tbl.style = "Table Grid"
    cell = tbl.cell(0, 0)
    shade(cell, PALE_BLUE)
    cell_margins(cell, 120, 160, 120, 160)
    p = cell.paragraphs[0]
    set_run(p.add_run(title + ": "), 11, bold=True, color=DARK_BLUE)
    set_run(p.add_run(body), 11)
    set_table_width(tbl, [9360])
    doc.add_paragraph()


def build():
    doc = Document()
    style_doc(doc)
    add_header_footer(doc)
    add_title(doc)

    doc.add_heading("1. Короткий висновок", level=1)
    callout(
        doc,
        "Нова стратегічна рамка",
        "OctoMind треба продавати як AI-маркетолога, який памʼятає бізнес, досліджує ринок і тренди, створює просування та матеріали. Не як старий відео-редактор, не як генератор каруселей і не як окремий caption tool.",
    )
    bullets(doc, [
        "Головний promise: від хаотичного маркетингу до готової кампанії з матеріалами за кілька хвилин.",
        "Найсильніші entry points: перше просування, реклама товару з фото, тренди в ніші, розбір сторінки, дослідження ринку.",
        "Перший paid test має вести не на абстрактний дашборд, а на конкретну дію: зробити кампанію, проаналізувати товар, знайти тренди або розібрати сторінку.",
        "Перед рекламою треба прибрати із видимих поверхонь залишки старого позиціонування: Video Creator, Carousel Builder, окремі субтитри як головний продукт.",
        "Тарифна логіка зараз добра для freemium: Free дає перший результат, Pro $12 відкриває регулярне просування, Business $29 варто продавати через вищі ліміти, кілька бізнесів, пріоритет і ранній доступ, а не через обіцянку вже готової відео-реклами.",
    ])

    doc.add_heading("2. Актуальний продукт", level=1)
    table(doc, ["Модуль", "Що реально робить", "Маркетинговий сенс"], [
        ("Знайомство / бізнес-профіль", "Користувач описує бізнес, нішу, аудиторію, гео, ціль, tone of voice. Octo використовує це в наступних генераціях.", "Це не разовий генератор, а маркетолог із памʼяттю про бізнес."),
        ("Ask Octo", "Чат-маркетолог для стратегії, підписів, контент-плану, порад для росту.", "Підтримка між діями: користувач може уточнювати й просити ідеї."),
        ("Просування", "Ціль -> деталі -> стратегія -> матеріали. Кампанія зберігається в «Мої ідеї».", "Головна фіча для продажу: не просто текст, а готова маркетингова кампанія."),
        ("Мої ідеї", "Бібліотека кампаній, матеріалів, трендових ідей, рекламних креативів.", "Дає відчуття системи й накопиченої роботи, а не одноразового чату."),
        ("Реклама товару", "Фото товару -> аналіз -> дані товару -> ціль/платформа/стиль -> 3 концепції -> креативи й тексти.", "Найсильніший комерційний use case для e-commerce, локальних брендів, бʼюті, їжі, мерчу."),
        ("Тренди", "Реальні TikTok/Instagram ролики в ніші з переглядами, датами, фільтрами й AI-розбором.", "Дає користувачу відчуття: Octo бачить ринок, а не вигадує в вакуумі."),
        ("Дослідження ринку", "Web-пошук по ніші: аудиторія, офери, хуки, тренди, конкуренти, KPI, швидкі перемоги.", "Сильний B2B-аргумент: Octo допомагає думати, а не тільки писати."),
        ("Розбір контенту / сторінки", "Аудит Instagram/TikTok або завантажених постів: слабкі місця, план покращень.", "Ідеальний lead magnet для реклами: люди хочуть дізнатися, що не так з їхнім профілем."),
        ("Ідея з тренду", "Посилання/опис/скрін тренду -> оригінальна ідея під конкретний бізнес.", "Місток між трендами й практичною дією."),
        ("Бренд-стиль", "Палітра, тон, слоган, logo prompt/лого; майбутні матеріали тримають стиль.", "Підсилює цінність Pro: брендова консистентність."),
        ("Тексти й контент-план", "Пости, оголошення, підписи, планування матеріалів у календар.", "Фінальний операційний шар: що саме публікувати й коли."),
    ], [1850, 3920, 3590])

    doc.add_heading("3. Тарифи й ліміти", level=1)
    table(doc, ["План", "Ціна", "Ключові ліміти / цінність", "Роль у воронці"], [
        ("Free", "$0/міс", "1 кампанія; 3 AI-зображення/міс; 1 пак реклами товару; тренди 3 ролики/день; Ask Octo 10 запитів; 1 розбір сторінки/день.", "Дати перший відчутний результат і підвести до ліміту."),
        ("Pro", "$12/міс", "До 10 кампаній/міс; близько 30 AI-зображень + реклама товару; тренди повністю + AI-розбір; Ask Octo без ліміту; бренд-стиль; контент-план; дослідження ринку.", "Основний план для малого бізнесу, блогерів, експертів і власників, які не хочуть платити SMM-фахівцю."),
        ("Business", "$29/міс", "Все з Pro, вищі ліміти; кілька бізнесів/воркспейсів; пріоритетна генерація; ранній доступ до нових фіч. AI-відео реклами краще маркувати як soon/early access, доки фіча не продається стабільно.", "Для власників кількох проєктів, активних блогерів, e-commerce і тих, кому треба більше лімітів."),
    ], [1450, 1050, 5000, 2860])

    doc.add_heading("4. Що не можна більше продавати як ядро", level=1)
    bullets(doc, [
        "Не позиціонувати OctoMind як старий AI video editor.",
        "Не будувати рекламу навколо каруселей, субтитрів або шаблонної обробки відео, якщо ці функції видалені або не є активним ядром продукту.",
        "Не використовувати стару цінову сітку або старі назви тарифів.",
        "Не писати «завантаж відео -> AI вибере шаблон» як головний сценарій. Актуальний продукт сильніший: бізнес-профіль, кампанії, тренди, product ads, матеріали.",
        "Якщо у live-інтерфейсі ще видно старі картки Video Creator / Carousel Builder, їх варто прибрати або переназвати до запуску реклами, бо це ламає очікування користувача.",
    ])

    doc.add_heading("5. Позиціонування", level=1)
    callout(
        doc,
        "Формула",
        "OctoMind — AI-маркетолог для малого бізнесу, блогерів, експертів і креаторів в Україні: він запамʼятовує бізнес, знаходить тренди й ринкові інсайти, створює кампанії, рекламні креативи, тексти та контент-план без необхідності одразу наймати SMM-фахівця.",
    )
    table(doc, ["Не так", "Так"], [
        ("AI tool для контенту", "AI-маркетолог, який веде від бізнес-цілі до готових матеріалів."),
        ("Згенеруй підпис", "Створи перше просування: стратегія, офер, матеріали, план дій."),
        ("Роби відео й каруселі", "Знайди, що працює у твоїй ніші, і адаптуй це під твій бізнес."),
        ("Ще один чат", "Маркетолог із памʼяттю про твій бізнес, сторінку, ринок і бренд-стиль."),
        ("Плати за AI", "Отримай кампанію, яка може окупити Pro одним клієнтом."),
    ], [3100, 6260])

    doc.add_heading("6. Пріоритетні сегменти ЦА", level=1)
    table(doc, ["Сегмент", "Біль живою мовою", "Що продавати першим", "Найкращий hook"], [
        ("Малий локальний бізнес", "Я розумію свій бізнес, але не знаю, що постити й як це перетворити в заявки.", "Перше просування + контент-план + розбір сторінки.", "Octo зробить тобі кампанію на тиждень, а не просто текст."),
        ("Товарні бренди / e-commerce", "У мене є товар, але реклама виглядає слабко, а дизайнер дорого.", "Реклама товару з фото: концепції, креативи, тексти.", "Завантаж фото товару -> отримай рекламні креативи."),
        ("Блогери / креатори", "Я хочу рости, але не хочу платити SMM-фахівцю або чекати, поки хтось придумає мені контент.", "Тренди + ідея з тренду + Ask Octo + контент-план.", "Octo допоможе адаптувати тренди під тебе, а не копіювати чужі відео."),
        ("SMM-фрилансери", "Клієнтів більше, ніж сил. Треба швидко робити стратегії, ідеї, тексти й матеріали.", "Другорядний сегмент для Pro/Business після валідації малого бізнесу й блогерів.", "Веди більше клієнтів без хаосу в ідеях."),
        ("Експерти / особисті бренди", "Я знаю свою тему, але контент виходить випадковий і не продає.", "Знайомство, стратегія, ідеї з трендів, тексти.", "Перетвори експертність у зрозумілий контент-план."),
    ], [1600, 2700, 2400, 2660])

    doc.add_heading("7. Рекламна воронка", level=1)
    numbers(doc, [
        "Креатив у рекламі обіцяє одну конкретну дію: розібрати сторінку, створити першу кампанію, знайти тренди або зробити рекламу товару.",
        "Лендинг або deep-link веде не на загальний дашборд, а на відповідний сценарій: «Просування», «Реклама товару», «Тренди», «Розбір контенту».",
        "Користувач проходить «Знайомство», щоб Octo знав бізнес. Це треба подавати як перевагу, а не як анкету.",
        "Перший результат має бути безкоштовним і відчутним: кампанія, аудит, трендові ідеї або product ad pack.",
        "Paywall зʼявляється після цінності: ліміт Free показує, що Pro $12 дає регулярне просування, а Business $29 дає вищі ліміти, кілька бізнесів і ранній доступ.",
        "Retargeting доганяє тих, хто почав, але не завершив: показує приклади результатів і пояснює окупність.",
    ])

    doc.add_heading("8. Paid ads: перші тести", level=1)
    table(doc, ["Тест", "Аудиторія", "Офер", "Куди вести", "Бюджет"], [
        ("A. Перша кампанія", "локальний бізнес, послуги, експерти в Україні", "Octo зробить стратегію й матеріали під твою ціль українською.", "Просування / Знайомство", "$10-20/день"),
        ("B. Реклама товару", "e-commerce, косметика, їжа, handmade, локальні бренди", "Завантаж фото товару -> отримай рекламні креативи й тексти.", "Реклама товару", "$10-20/день"),
        ("C. Розбір сторінки", "Instagram/TikTok бізнес-акаунти", "Дізнайся, чому сторінка не продає.", "Розбір контенту", "$10-20/день"),
        ("D. Тренди в ніші", "блогери, creators, експерти", "Подивись реальні вірусні ролики у своїй ніші й адаптуй під себе.", "Тренди / Ідея з тренду", "$10-20/день"),
        ("E. Без SMM-фахівця", "малі бізнеси й блогери з обмеженим бюджетом", "Маркетингові ідеї, тексти й кампанії без постійної оплати SMM.", "Pro landing", "$10-20/день"),
    ], [1350, 2300, 2800, 1750, 1160])

    doc.add_heading("9. Креативні кути", level=1)
    table(doc, ["Кут", "Сценарій короткого відео", "Для кого"], [
        ("До / після", "Було: порожній контент-план. Стало: кампанія, матеріали й календар у OctoMind.", "малий бізнес, експерти"),
        ("Фото товару", "Показати товарне фото -> Octo аналізує -> 3 концепції -> рекламний креатив.", "e-commerce, локальні бренди"),
        ("Тренд без копіювання", "Знайшов тренд у ніші -> Octo пояснив, чому зайшло -> зробив оригінальну ідею.", "блогери, креатори"),
        ("Без SMM-бюджету", "Не маєш SMM-фахівця? Octo збере кампанію, тексти й контент-план під твій бізнес.", "малий бізнес, блогери"),
        ("Окупність", "Pro $12/міс. Один клієнт із кампанії покриває підписку багато разів.", "малий бізнес"),
    ], [1800, 5300, 2260])

    doc.add_heading("10. Що підготувати перед запуском реклами", level=1)
    table(doc, ["Актив", "Що саме потрібно"], [
        ("Лендинги", "4 окремі сторінки або стани: перша кампанія, реклама товару, розбір сторінки, тренди в ніші."),
        ("Аналітика", "Події: view, start onboarding, finish onboarding, start feature, get result, save to My Ideas, hit limit, checkout, paid."),
        ("Приклади результатів", "Скрін/демо для кожного use case: кампанія, product ads, дослідження ринку, тренди, розбір сторінки."),
        ("Очищення інтерфейсу", "Прибрати видимі legacy-картки Video Creator / Carousel Builder або чітко сховати їх від нового позиціонування."),
        ("Email/retargeting", "5 повідомлень: результат, наступний крок, кейс, ліміт Free, пропозиція Pro/Business."),
        ("Оплата", "WayForPay checkout має працювати для Pro $12 і Business $29; бажано показувати live/test статус тільки в адмін/налаштуваннях."),
        ("Соціальні докази", "Мінімум 3 демонстраційні кейси для України: локальний бізнес послуг, товарний бренд, блогер/експерт."),
    ], [2300, 7060])

    doc.add_heading("11. 30 / 60 / 90 днів", level=1)
    table(doc, ["Період", "Ціль", "Дії", "Рішення"], [
        ("1-30 днів", "Валідувати, який entry point дає активацію.", "Запустити 4 офери; зібрати 12-20 креативів; налаштувати події; прибрати legacy UI; взяти 10 інтервʼю.", "Обрати 1-2 найсильніші сценарії для масштабування."),
        ("31-60 днів", "Підняти конверсію Free -> Pro.", "Покращити onboarding; додати result-based paywall; зробити кейси; запустити retargeting.", "Pro має мати зрозумілий CAC-to-paid шлях."),
        ("61-90 днів", "Масштабувати канал і Business-пакет.", "Партнерки з блогерами/експертами, affiliate, Business для кількох проєктів, SEO-сторінки під jobs-to-be-done.", "Масштабувати тільки сценарії з активацією й оплатою."),
    ], [1300, 1700, 4500, 1860])

    doc.add_heading("12. KPI для першого місяця", level=1)
    table(doc, ["Метрика", "Орієнтир", "Навіщо"], [
        ("CTR креативів", "1.5%+ для Meta/TikTok як перший сигнал", "Чи чіпляє біль і promise."),
        ("Start onboarding", "20-35%+ від landing visitors", "Чи зрозуміло, навіщо розповідати про бізнес."),
        ("Finish onboarding", "60%+ тих, хто почав", "Чи не занадто важке знайомство."),
        ("First result", "30%+ зареєстрованих", "Головна активація продукту."),
        ("Save to My Ideas / Calendar", "15-25%+ активованих", "Чи бачить користувач систему, а не одноразову генерацію."),
        ("Free -> Pro", "2-5% на старті, далі оптимізувати", "Чи працює $12 Pro як регулярний план."),
    ], [2300, 2300, 4760])

    doc.add_heading("13. Уточнення від власника продукту", level=1)
    bullets(doc, [
        "Перший ринок для запуску реклами: Україна.",
        "Business $29 поки не треба продавати через AI-відео як стабільну готову фічу; текст тарифу варто змінити на вищі ліміти, кілька бізнесів, пріоритет і ранній доступ.",
        "Найстабільніша фіча для користувача залежить від запиту клієнта, тому реклама має тестувати кілька entry points: перша кампанія, реклама товару, тренди, розбір сторінки.",
        "Основна ЦА для старту: малі бізнеси й блогери, які не хочуть або не можуть витрачати гроші на SMM-фахівця.",
        "Мовна стратегія: для України зробити українську основною мовою реклами, лендингів, onboarding і ключових екранів. Перемикач мов можна залишити, але перший рекламний шлях має бути без міксу UA/RU/EN.",
    ])

    doc.add_heading("14. Мовна стратегія для України", level=1)
    callout(
        doc,
        "Рекомендація",
        "Так, для першого запуску в Україні варто зробити українську мовою за замовчуванням у рекламі, лендингах, onboarding, тарифах і ключових product flows. Це не означає прибрати інші мови назавжди; це означає прибрати мовний шум з першого досвіду.",
    )
    bullets(doc, [
        "У рекламних креативах: тільки українська, з живою мовою малого бізнесу й блогерів.",
        "У продукті після кліку: українська за замовчуванням; англійські назви типу Pro/Business можна залишити, але пояснення — українською.",
        "Російську не змішувати в українському рекламному шляху. Якщо вона потрібна пізніше, краще зробити окремий language switch, а не мікс на одному екрані.",
        "AI-відповіді Octo мають автоматично відповідати українською, якщо профіль/інтерфейс український.",
        "Для України особливо важливо, щоб продукт не виглядав як машинний переклад або недороблений мультимовний шаблон.",
    ])

    doc.add_heading("15. Джерела й перевірка", level=1)
    bullets(doc, [
        "Live-сайт OctoMind, перевірено 9 липня 2026: https://octomind-production.up.railway.app/",
        "Актуальні файли продукту: mobile/web-demo.html, backend/src/routes/marketing.ts, backend/src/routes/ads.ts, backend/src/services/quota.ts, backend/src/services/payments/wayforpay.ts.",
        "Тарифи з live-сайту й коду: Free $0, Pro $12/міс, Business $29/міс.",
        "Конкурентний контекст: Buffer, Predis.ai, Canva, Hootsuite/Sprout-подібні SMM suites. Їхня сила — scheduling/design/AI content; шанс OctoMind — ціль -> стратегія -> матеріали -> тренди -> памʼять про бізнес.",
    ])

    doc.save(OUT)


if __name__ == "__main__":
    build()
    print(OUT)
