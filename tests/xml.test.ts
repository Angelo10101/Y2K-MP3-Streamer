import { describe, expect, it } from "vitest";
import { parseXml } from "../src/wmp/xml";

describe("lenient wms xml", () => {
  it("parses mixed case, unquoted attrs, comments and self-closing tags", () => {
    const r = parseXml(`<?wmpskin?><THEME><!-- c --><VIEW Width=100 height="50" clippingColor='#FF00FF'>
      <BUTTONELEMENT id="a" onclick="jscript:x(1 &amp;&amp; 2);"/><TEXT id=t value="a>b"></VIEW></THEME>`);
    const view = r.children[0].children[0];
    expect(view.tag).toBe("view");
    expect(view.attrs).toMatchObject({ width: "100", height: "50", clippingcolor: "#FF00FF" });
    expect(view.children.map((c) => c.tag)).toEqual(["buttonelement", "text"]);
    expect(view.children[0].attrs.onclick).toBe("jscript:x(1 && 2);");
    expect(view.children[1].attrs.value).toBe("a>b");
  });
});
