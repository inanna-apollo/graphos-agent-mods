"""Turn a `tmux capture-pane -p -e` capture (stdin) into an HTML page (stdout).

Parses SGR colors (16, 256 and truecolor), bold, dim, italic, underline and
inverse into a cell grid, drops OSC 8 hyperlinks and other escapes, and with
`--pane` crops to the GraphOS Inspector pane: the columns from its left border
(the `│` before its header row) to the end of each line.

    tmux capture-pane -p -e -t tester | python3 scripts/ansi2html.py --pane > pane.html
"""
import html
import re
import sys

BASE16 = [
    '#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
    '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea',
]
FG, BG = '#d0d0d0', '#262626'
HEADER = ('│ READ', '│[READ]', '│ WRITE', '│[WRITE]', '│ WATCH', '│[WATCH]')


def color256(n: int) -> str:
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return '#%02x%02x%02x' % (v, v, v)


def sgr(params: list[int], st: dict) -> None:
    i = 0
    if not params:
        params = [0]
    while i < len(params):
        p = params[i]
        if p == 0:
            st.clear()
        elif p == 1:
            st['bold'] = True
        elif p == 2:
            st['dim'] = True
        elif p == 3:
            st['italic'] = True
        elif p == 4:
            st['underline'] = True
        elif p == 7:
            st['inverse'] = True
        elif p == 22:
            st.pop('bold', None)
            st.pop('dim', None)
        elif p == 23:
            st.pop('italic', None)
        elif p == 24:
            st.pop('underline', None)
        elif p == 27:
            st.pop('inverse', None)
        elif 30 <= p <= 37:
            st['fg'] = BASE16[p - 30]
        elif 90 <= p <= 97:
            st['fg'] = BASE16[p - 90 + 8]
        elif 40 <= p <= 47:
            st['bg'] = BASE16[p - 40]
        elif 100 <= p <= 107:
            st['bg'] = BASE16[p - 100 + 8]
        elif p == 39:
            st.pop('fg', None)
        elif p == 49:
            st.pop('bg', None)
        elif p in (38, 48) and i + 1 < len(params):
            key = 'fg' if p == 38 else 'bg'
            if params[i + 1] == 5 and i + 2 < len(params):
                st[key] = color256(params[i + 2])
                i += 2
            elif params[i + 1] == 2 and i + 4 < len(params):
                st[key] = '#%02x%02x%02x' % tuple(params[i + 2:i + 5])
                i += 4
        i += 1


TOKEN = re.compile(r'\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b.')


def grid(line: str) -> list[tuple[str, dict]]:
    """One line as (char, style) cells; style dicts are copied per change."""
    cells, st, pos = [], {}, 0
    for m in TOKEN.finditer(line):
        for ch in line[pos:m.start()]:
            cells.append((ch, dict(st)))
        if m.group(1) is not None:
            sgr([int(x) for x in re.split('[;:]', m.group(1)) if x != ''], st)
        pos = m.end()
    for ch in line[pos:]:
        cells.append((ch, dict(st)))
    return cells


def css(st: dict) -> str:
    fg, bg = st.get('fg', FG), st.get('bg')
    if st.get('inverse'):
        fg, bg = bg or BG, fg
    out = [f'color:{fg}']
    if bg:
        out.append(f'background:{bg}')
    if st.get('bold'):
        out.append('font-weight:bold')
    if st.get('dim'):
        out.append('opacity:.6')
    if st.get('italic'):
        out.append('font-style:italic')
    if st.get('underline'):
        out.append('text-decoration:underline')
    return ';'.join(out)


def main() -> None:
    lines = [grid(line) for line in sys.stdin.read().splitlines()]
    if '--pane' in sys.argv:
        plain = [''.join(ch for ch, _ in cells) for cells in lines]
        edge = next((i for text in plain for key in HEADER if (i := text.find(key)) >= 0), None)
        if edge is None:
            sys.exit('no inspector pane on screen')
        lines = [cells[edge:] for cells, text in zip(lines, plain) if text[edge:edge + 1] == '│']
        while lines and ''.join(ch for ch, _ in lines[-1]).strip('│ ') == '':
            lines.pop()
    rows = []
    for cells in lines:
        spans, run, prev = [], '', None
        for ch, st in cells + [('', None)]:
            key = None if st is None else css(st)
            if key != prev and run:
                spans.append(f'<span style="{prev}">{html.escape(run)}</span>')
                run = ''
            run += ch
            prev = key
        rows.append(''.join(spans))
    print(f'''<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:{BG}}}
pre{{margin:0;padding:12px;font:15px/1.25 "SF Mono",Menlo,monospace;color:{FG};display:inline-block}}
</style><pre>{chr(10).join(rows)}</pre>''')


if __name__ == '__main__':
    main()
