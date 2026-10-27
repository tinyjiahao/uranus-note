import { test, expect } from './fixtures';
import { testEmail, testPassword } from './credentials';
import type { Editor } from '@tiptap/core';
test.use({ trace: 'off' });
test('paragraph menu switches normal, small and all six headings without invalid marks', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(testEmail());
  await page.getByLabel('密码', { exact: true }).fill(testPassword());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByTitle('新建笔记 (⌘N)').click();
  const body = page.locator('.prose-editor');
  await expect(body).toBeVisible();
  await page.getByLabel('笔记标题', { exact: true }).fill('段落菜单测试');
  await body.fill('段落内容');
  const trigger = page.getByRole('button', { name: '段落样式', exact: true });
  const choose = async (name: string) => {
    await trigger.click();
    await page.getByRole('dialog', { name: '段落样式' }).getByRole('button', { name, exact: true }).click();
    await expect(trigger).toContainText(name);
  };
  await body.evaluate(el => { const editor = (el as HTMLElement & { editor: Editor }).editor; editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild!.nodeSize - 1 }); });
  await choose('小号文本');
  await expect(body.locator('small')).toHaveText('段落内容');
  for (let level=1;level<=6;level++) {
    await choose(`标题 ${level}`);
    await expect(body.locator(`h${level}`)).toHaveText('段落内容');
    await expect(body.locator('small')).toHaveCount(0);
  }
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存到服务器');
  await page.reload();
  await expect(body.locator('h6')).toHaveText('段落内容');
  await body.locator('h6').click();
  await choose('普通文本');
  await expect(body.locator('p').first()).toHaveText('段落内容');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
