/* global File, TextEncoder */
import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { droppedFiles, folderFiles, zipFiles } from "./import-files";

test("ZIP import keeps nested MT5 data paths and rejects symlinks before extraction", async () => {
  const bytes = zipSync({ "MT5/MQL5/Files/EA/settings.json": new TextEncoder().encode("fixture") });
  const files = await zipFiles(new File([bytes], "MT5.zip"));
  expect(files[0]?.path).toBe("MT5/MQL5/Files/EA/settings.json");
  expect(await files[0]?.file.text()).toBe("fixture");
  const altered = bytes.slice();
  const view = new DataView(altered.buffer);
  for (let offset = 0; offset < altered.length - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 38, 0xa0000000, true);
      break;
    }
  }
  await expect(zipFiles(new File([altered], "link.zip"))).rejects.toThrow("symbolic links");
  const lying = bytes.slice();
  const lyingView = new DataView(lying.buffer);
  for (let offset = 0; offset < lying.length - 46; offset++) {
    if (lyingView.getUint32(offset, true) === 0x02014b50) {
      lyingView.setUint32(offset + 24, 1, true);
      break;
    }
  }
  await expect(zipFiles(new File([lying], "lying.zip"))).rejects.toThrow("declared size");
});

test("directory drop keeps the selected folder and reads every directory batch", async () => {
  const source = new File(["settings"], "settings.json");
  const file = (name) => ({ name, isFile: true, isDirectory: false, file: (resolve) => resolve(source) });
  const directory = (name, batches) => ({
    name, isFile: false, isDirectory: true,
    createReader: () => {
      let index = 0;
      return { readEntries: (resolve) => resolve(batches[index++] ?? []) };
    },
  });
  const root = directory("ExampleEA", [
    [file("ExampleEA.ex5")],
    [directory("resources", [[file("settings.json")]])],
  ]);
  const selected = await droppedFiles({ items: [{ kind: "file", webkitGetAsEntry: () => root }], files: [] });
  expect(selected.map(({ path }) => path)).toEqual(["ExampleEA/ExampleEA.ex5", "ExampleEA/resources/settings.json"]);
  expect(selected[1].file).toBe(source);
});

test("file drop fallback and folder picker preserve the exact browser-exposed paths", async () => {
  const file = new File(["fixture"], "EA.ex5");
  const plain = await droppedFiles({ items: [{ kind: "file" }], files: [file] });
  expect(plain[0].path).toBe("EA.ex5");
  Object.defineProperty(file, "webkitRelativePath", { value: "SelectedFolder/MQL5/Experts/EA.ex5" });
  expect(folderFiles([file])[0].path).toBe("SelectedFolder/MQL5/Experts/EA.ex5");
});

test("inaccessible and text-only drops cannot silently become partial transfers", async () => {
  const entry = { name: "folder", isDirectory: true };
  await expect(droppedFiles({ items: [{ kind: "file", webkitGetAsEntry: () => entry }, { kind: "file", webkitGetAsEntry: () => null }], files: [] })).rejects.toThrow("every dropped item");
  await expect(droppedFiles({ items: [{ kind: "string" }], files: [] })).rejects.toThrow("Choose folder");
});
