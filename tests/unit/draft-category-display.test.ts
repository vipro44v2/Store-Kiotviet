import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { parseDraftCategoryIds } from "@/lib/settings/draft-categories";
import { SettingsEditor } from "@/components/admin/settings-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it.each([null, undefined, {}, "old value", [], { categoryIds: null }, { categoryIds: "10" }])(
  "renders malformed stored setting %j as an empty selection", (value) => {
    expect(parseDraftCategoryIds(value)).toEqual([]);
    const html = renderToStaticMarkup(createElement(SettingsEditor, {
      settings: [{ key: "draft_product_categories", value }],
    }));
    expect(html).toContain("Draft product categories");
    expect(html).not.toContain('type="checkbox"');
  },
);

it("normalizes legacy IDs and displays each valid selection once", () => {
  const value = { categoryIds: [20, 10, 10, 0, -1, 1.5, "30", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1] };
  expect(parseDraftCategoryIds(value)).toEqual([10, 20]);
  const html = renderToStaticMarkup(createElement(SettingsEditor, {
    settings: [{ key: "draft_product_categories", value }],
  }));
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html.match(/checked=""/g)).toHaveLength(2);
});
