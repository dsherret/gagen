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
    Deno.writeTextFileSync(
      "npm/LICENSE",
      Deno.readTextFileSync("LICENSE").replaceAll(
        "jsr:@david/gagen@<version>",
        "gagen",
      ),
    );
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
