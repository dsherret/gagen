import { Step } from "./step.ts";

export interface UploadConfig {
  path: string;
  retentionDays?: number;
}

export interface DownloadConfig {
  path?: string;
}

export interface ArtifactOptions {
  version?: string;
}

export class Artifact {
  readonly name: string;
  readonly #version: string;
  #uploadStep?: Step<string>;

  constructor(name: string, options?: ArtifactOptions) {
    this.name = name;
    this.#version = options?.version ?? "v6";
  }

  upload(config: UploadConfig): Step {
    const withObj: Record<string, string | number | boolean> = {
      name: this.name,
      path: config.path,
    };
    if (config.retentionDays != null) {
      withObj["retention-days"] = config.retentionDays;
    }
    const s = new Step({
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
    if (config.path != null) {
      withObj.path = config.path;
    }
    const s = new Step({
      uses: `actions/download-artifact@${this.#version}`,
      with: withObj,
    });
    if (this.#uploadStep) {
      s._crossJobDeps.push(this.#uploadStep);
    }
    return s;
  }
}

export function defineArtifact(
  name: string,
  options?: ArtifactOptions,
): Artifact {
  return new Artifact(name, options);
}
