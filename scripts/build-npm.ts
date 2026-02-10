import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: ["./src/mod.ts"],
  outDir: "./npm",
  typeCheck: false,
  scriptModule: false,
  shims: {
    deno: "dev",
  },
  package: {
    name: "gagen",
    version: Deno.args[0],
    description:
      "Generate complex GitHub Actions YAML files using a declarative API.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/dsherret/gagen.git",
    },
    bugs: {
      url: "https://github.com/dsherret/gagen/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.writeTextFileSync(
      "npm/README.md",
      Deno.readTextFileSync("README.md").replaceAll(
        "jsr:@david/gagen@<version>",
        "gagen",
      ).replaceAll(
        "jsr:@david/gagen",
        "gagen",
      ),
    );
  },
});
