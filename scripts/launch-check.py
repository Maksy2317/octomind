#!/usr/bin/env python3
"""Передзапускова перевірка OctoMind — одна команда замість десяти скриптів.

Запуск:
    python3 scripts/launch-check.py
    ADMIN_KEY=... python3 scripts/launch-check.py     # ще й статистика з воронкою

Правило, вистраждане за два дні: судимо за ЗМІСТОМ відповіді, а не за кодом
HTTP. Раніше і 200 на неіснуючому файлі (SPA-фолбек), і 400 замість 404
(перевірка заголовка раніше за маршрут) видавали хибні висновки.
"""
import json, os, subprocess, sys, time

BASE = os.environ.get('OCTO_BASE', 'https://octomind.win')
ADMIN = os.environ.get('ADMIN_KEY', '')
DEV = 'biz_launchcheck_' + str(int(time.time()))

ok_count = bad = warn = 0


def call(method, path, body=None, headers=None, timeout='90'):
    cmd = ['curl', '-s', '-m', timeout, '-X', method, BASE + path, '-w', '|%{http_code}']
    for k, v in (headers or {}).items():
        cmd += ['-H', f'{k}: {v}']
    if body is not None:
        cmd += ['-H', 'content-type: application/json', '--data-binary', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    code = out.rsplit('|', 1)[-1].strip()
    raw = out.rsplit('|', 1)[0]
    try:
        return code, json.loads(raw)
    except Exception:
        return code, raw


def check(name, state, detail=''):
    """state: True | False | 'warn'"""
    global ok_count, bad, warn
    if state == 'warn':
        warn += 1; mark = '⚠️ '
    elif state:
        ok_count += 1; mark = '✅'
    else:
        bad += 1; mark = '⛔'
    print(f'  {mark} {name}')
    if detail:
        print(f'      {detail}')


print(f'\n╔══ Передзапускова перевірка · {BASE}\n')

# ── 1. Сервер живий і який саме код на ньому ─────────────────────────────────
print('── Деплой')
code, v = call('GET', '/api/version')
sha = (v or {}).get('sha') if isinstance(v, dict) else None
check('сервер відповідає', code == '200' and bool(sha), f"збірка {sha}, старт {(v or {}).get('bootedAt','')}")

# ── 2. База ──────────────────────────────────────────────────────────────────
print('\n── База даних')
code, u = call('GET', '/api/usage', headers={'x-device-id': DEV})
db_ok = code == '200' and isinstance(u, dict) and 'plan' in u
check('Supabase відповідає', db_ok, f"тариф нового пристрою: {(u or {}).get('plan')}")

# ── 3. Гроші ─────────────────────────────────────────────────────────────────
print('\n── Оплата')
code, p = call('GET', '/api/pay/plans')
live = bool((p or {}).get('live')) if isinstance(p, dict) else False
plans = (p or {}).get('plans', {}) if isinstance(p, dict) else {}
prices = ' · '.join(f"{k}: {v.get('amount')} {v.get('currency')}" for k, v in plans.items())
check('ціни віддаються', bool(plans), prices)
if live:
    check('бойовий білінг', True, 'ключі WayForPay на місці — оплата працює')
else:
    code, c = call('POST', '/api/pay/create', {'plan': 'pro'}, {'x-device-id': DEV})
    honest = code == '503' and isinstance(c, dict) and c.get('code') == 'billing_not_live'
    check('білінг вимкнений, але ЧЕСНО', honest if honest else 'warn',
          'без ключів /pay/create відмовляє з поясненням' if honest
          else f'очікував 503 billing_not_live, отримав {code}')
    check('ФОП + ключі WayForPay', 'warn', 'ДОКИ НЕ ЗРОБЛЕНО — доходу немає')

# ── 4. Сповіщення ────────────────────────────────────────────────────────────
print('\n── Сповіщення')
code, k = call('GET', '/api/push/vapid-public-key')
push_ok = code == '200' and isinstance(k, dict) and bool(k.get('key'))
check('VAPID-ключі налаштовані', push_ok, 'пуші можуть надсилатись' if push_ok else 'нагадування не працюватимуть')
code, _ = call('POST', '/api/push/test', {})
check('розсилка всім закрита ключем', code == '403')

# ── 5. Тренди ────────────────────────────────────────────────────────────────
print('\n── Тренди')
t0 = time.time()
code, f = call('POST', '/api/trends/feed', {'platform': 'tiktok', 'query': 'кава'}, {'x-device-id': DEV})
# Поле саме `videos` — перша версія скрипта шукала `items` і оголосила
# робочу фічу зламаною. Судимо за вмістом, але спершу знаємо його форму.
items = len((f or {}).get('videos', [])) if isinstance(f, dict) else 0
check('TikTok віддає ролики', code == '200' and items > 0, f'{items} шт за {time.time()-t0:.0f} с')
code, ig = call('POST', '/api/trends/feed', {'platform': 'instagram', 'query': 'кава'}, {'x-device-id': DEV})
ig_ready = code == '200'
check('Instagram', ig_ready if ig_ready else 'warn',
      'працює' if ig_ready else 'ще не готовий — застосунок каже про це чесно')

# ── 6. AI ────────────────────────────────────────────────────────────────────
print('\n── AI')
prof = {'business_name': 'Тест', 'niche': 'кавʼярня', 'description': 'Спешелті кава і сніданки',
        'target_audience': 'місцеві', 'geo': 'Київ'}
t0 = time.time()
code, st = call('POST', '/api/marketing/strategy', {'goal': 'Більше клієнтів', 'profile': prof},
                {'x-device-id': DEV})
s = (st or {}).get('strategy', {}) if isinstance(st, dict) else {}
check('стратегія генерується', code == '200' and bool(s.get('offer')),
      f"{len(s)} блоків за {time.time()-t0:.0f} с")

# ── 7. Безпека ───────────────────────────────────────────────────────────────
print('\n── Безпека')
code, _ = call('GET', '/api/profile', headers={'x-device-id': 'auth_00000000-0000-0000-0000-000000000001'})
check('зарезервований префікс auth_ ріжеться', code == '400')
code, b = call('POST', '/api/marketing/import', {'url': 'http://169.254.169.254/latest/meta-data/'},
               {'x-device-id': DEV}, timeout='45')
blocked = isinstance(b, dict) and b.get('code') == 'url_blocked'
check('внутрішні адреси заблоковані', blocked)
code, _ = call('GET', '/api/profile', headers={'x-device-id': 'biz_default'})
shared = isinstance(_, dict) and (_ or {}).get('profile')
check('спільний biz_default не віддає чужий профіль', not shared)
code, _ = call('POST', '/api/pay/callback', {'merchantSignature': 'deadbeef', 'orderReference': 'x'})
check('вебхук оплати не приймає підробку', code in ('400', '403'))

# ── 8. Статистика (лише з ключем) ────────────────────────────────────────────
print('\n── Спостережуваність')
if ADMIN:
    code, stt = call('GET', '/api/admin/stats', headers={'x-admin-key': ADMIN})
    reg = (stt or {}).get('registrations', {}) if isinstance(stt, dict) else {}
    check('статистика доступна', code == '200' and bool(reg),
          f"реєстрацій: {reg.get('total')}, підтверджених: {reg.get('confirmed')}")
    code, fn = call('GET', '/api/admin/funnel?days=14', headers={'x-admin-key': ADMIN})
    steps = (fn or {}).get('funnel', []) if isinstance(fn, dict) else []
    top = steps[0]['unique'] if steps else 0
    check('воронка рахується', code == '200' and bool(steps),
          f"кроків: {len(steps)}, на вершині: {top} людей за 14 дн")
else:
    check('ADMIN_KEY не передано', 'warn', 'запусти з ADMIN_KEY=... щоб перевірити ще й статистику')

# ── 9. Лендинг ───────────────────────────────────────────────────────────────
print('\n── Лендинг')
code, html = call('GET', '/')
check('лендинг віддається', code == '200' and isinstance(html, str) and 'OctoMind' in html,
      f'{len(html) if isinstance(html, str) else 0} байт')

print(f'\n╚══ Підсумок: ✅ {ok_count}   ⚠️  {warn}   ⛔ {bad}\n')
if bad:
    print('   ⛔ — це зламане. Запускатись не можна, доки не полагоджено.\n')
elif warn:
    print('   Зламаного немає. ⚠️  — те, що ще не увімкнено (гроші, Instagram-тренди).\n')
else:
    print('   Усе зелене.\n')
sys.exit(1 if bad else 0)
