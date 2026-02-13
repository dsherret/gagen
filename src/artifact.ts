import { Step } from "../src/step.ts";

export interface UploadConfig {
  path: string;
  retentionDays?: number;
}

export interface DownloadConfig {
  dirPath?: string;
}

export interface ArtifactOptions {
  version?: string;
  retentionDays?: number;
}

export class Artifact {
  readonly name: string;
  readonly #version: string;
  readonly #retentionDays?: number;
  #uploadStep?: Step<string>;

  constructor(name: string, options?: ArtifactOptions) {
    this.name = name;
    this.#version = options?.version ?? "v6";
    this.#retentionDays = options?.retentionDays;
  }

  upload(config: UploadConfig): Step {
    const withObj: Record<string, string | number | boolean> = {
      name: this.name,
      path: config.path,
    };
    const retentionDays = config.retentionDays ?? this.#retentionDays;
    if (retentionDays != null) {
      withObj["retention-days"] = retentionDays;
    }
    const s = new Step({
      name: `Upload artifact ${this.name}`,
      uses: `actions/upload-artifact@${this.#version}`,
      with: withObj,
    });
    this.#uploadStep = s;
    return s;
  }

  download(config: DownloadConfig = {}): Step {
    const withObj: Record<string, string | number | boolean> = {
      name: this.name,
    };
    if (config.dirPath != null) {
      withObj.path = config.dirPath;
    }
    return new Step(
      {
        name: `Download artifact ${this.name}`,
        uses: `actions/download-artifact@${this.#version}`,
        with: withObj,
      },
      this.#uploadStep ? [this.#uploadStep] : [],
    );
  }
}

export function defineArtifact(
  name: string,
  options?: ArtifactOptions,
): Artifact {
  return new Artifact(name, options);
}
