import { Step } from "./step.ts";

/** Options for {@linkcode Artifact.upload}. */
export interface UploadConfig {
  /** Path or glob of the files to upload. */
  path: string;
  /** Overrides the retention configured on the artifact. */
  retentionDays?: number;
}

/** Options for {@linkcode Artifact.download}. */
export interface DownloadConfig {
  /** Directory to extract the artifact into. */
  dirPath?: string;
}

/** Options for {@linkcode artifact}. */
export interface ArtifactOptions {
  /** Version of the upload/download actions to use. Defaults to `v6`. */
  version?: string;
  /** Default retention for uploads of this artifact. */
  retentionDays?: number;
}

/**
 * A named build artifact, providing the upload and download steps that move it
 * between jobs. A download automatically infers a job `needs` on every job that
 * uploads the artifact, regardless of the order the steps were created in.
 */
export class Artifact {
  /** The artifact name shared by its upload and download steps. */
  readonly name: string;
  readonly #version: string;
  readonly #retentionDays?: number;
  // shared by reference with every download step, so uploads created after a
  // download still contribute to that download's inferred `needs`
  readonly #uploadSteps: Step<string>[] = [];

  constructor(name: string, options?: ArtifactOptions) {
    this.name = name;
    this.#version = options?.version ?? "v6";
    this.#retentionDays = options?.retentionDays;
  }

  /** Creates a step that uploads the artifact. */
  upload(config: UploadConfig): Step {
    const withObj: Record<string, string | number | boolean> = {
      name: this.name,
      path: config.path,
    };
    const retentionDays = config.retentionDays ?? this.#retentionDays;
    if (retentionDays != null) {
      withObj["retention-days"] = retentionDays;
    }
    const uploadStep = new Step({
      name: `Upload artifact ${this.name}`,
      uses: `actions/upload-artifact@${this.#version}`,
      with: withObj,
    });
    this.#uploadSteps.push(uploadStep);
    return uploadStep;
  }

  /** Creates a step that downloads the artifact. */
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
      this.#uploadSteps,
    );
  }
}

/** Defines a named artifact to move files between jobs. */
export function artifact(
  name: string,
  options?: ArtifactOptions,
): Artifact {
  return new Artifact(name, options);
}
