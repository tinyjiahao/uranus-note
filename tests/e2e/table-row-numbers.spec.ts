import { test, expect } from './fixtures';
import { testEmail, testPassword } from './credentials';
import type { Editor } from '@tiptap/core';

test('row number gutter stays outside cells and preserves content and fixed column widths', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(testEmail());
  await page.getByLabel('密码', { exact: true }).fill(testPassword());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByTitle('新建笔记 (⌘N)').click();
  const body = page.locator('.prose-editor');
  await body.evaluate(el => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    editor.commands.setContent({ type: 'doc', content: [{ type: 'table', attrs: { widthMode: 'fixed' }, content:
      ['表头', '第一行\n多行内容', '第二行'].map((text, row) => ({ type: 'tableRow', content: [text, '内容'].map(text => ({
        type: row === 0 ? 'tableHeader' : 'tableCell', attrs: { colwidth: [180] }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })) })),
    }] });
  });
  const table = body.locator('table');
  const before = await body.evaluate(el => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    return { json: editor.getJSON(), html: editor.getHTML(), widths: [...el.querySelectorAll('tr:first-child > *')].map(c=>c.getBoundingClientRect().width), padding: getComputedStyle(el.querySelector('th')!).paddingLeft };
  });
  const toggle = async () => {
    await table.locator('th').first().click();
    await body.locator('.tableWrapper').hover();
    await page.getByRole('button', { name: '表格菜单', exact: true }).click();
    await page.getByRole('button', { name: /^(显示|隐藏)行号$/, exact: true }).click();
    await page.getByRole('button', { name: '关闭菜单', exact: true }).click();
  };
  await toggle();
  await expect(body.locator('.table-row-numbers span')).toHaveText(['1', '2']);
  await expect(body.locator('.table-row-number-header')).toHaveText('');
  const checkGeometry = async () => {
    const geometry = await body.evaluate(el => {
      const table = el.querySelector('table')!;
      const numbers = [...el.querySelectorAll('.table-row-number')];
      return { left: table.getBoundingClientRect().left, widths: [...table.rows[0]!.cells].map(c=>c.getBoundingClientRect().width), padding: getComputedStyle(table.rows[0]!.cells[0]!).paddingLeft,
        columns: [...el.querySelectorAll<HTMLElement>(".table-column-handle")].map((h,i)=>({visible:h.getClientRects().length>0,center:h.getBoundingClientRect().left+h.getBoundingClientRect().width/2, cellCenter:table.rows[0]!.cells[i]!.getBoundingClientRect().left+table.rows[0]!.cells[i]!.getBoundingClientRect().width/2})),
        rows: numbers.map((n,i)=>({ right:n.getBoundingClientRect().right, top:n.getBoundingClientRect().top, height:n.getBoundingClientRect().height, rowTop:table.rows[i]!.getBoundingClientRect().top, rowHeight:table.rows[i]!.getBoundingClientRect().height })) };
    });
    expect(geometry.widths).toEqual(before.widths);
    expect(geometry.padding).toBe(before.padding);
    for (const col of geometry.columns.filter(col => col.visible)) expect(Math.abs(col.center - col.cellCenter)).toBeLessThanOrEqual(1);
    for (const row of geometry.rows) {
      expect(Math.abs(row.right - geometry.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.top - row.rowTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.height - row.rowHeight)).toBeLessThanOrEqual(1);
    }
  };
  await checkGeometry();
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(before.json);
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getHTML())).toBe(before.html);
  await page.setViewportSize({ width: 390, height: 844 });
  await body.locator('.tableWrapper').evaluate(el => { el.scrollLeft = 25; });
  await checkGeometry();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '切换到只读模式', exact: true }).click();
  await checkGeometry();
  await page.emulateMedia({ media: 'print' });
  await expect(body.locator('.table-row-numbers')).toBeHidden();
  await expect(body.locator('.table-stage')).toHaveCSS('padding-left', '0px');
});
