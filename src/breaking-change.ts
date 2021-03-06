import { cli, devOps } from "@azure/avocado";
import * as oad from "@azure/oad";
import * as stringMap from "@ts-common/string-map";
import * as format from "@azure/swagger-validation-common";
import * as fs from "fs-extra";
import * as path from "path";

import * as tsUtils from "./ts-utils";
import { targetHref } from "./utils";
import * as utils from "./utils";

// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License in the project root for license information.

const headerText = `
| | Rule | Location | Message |
|-|------|----------|---------|
`;

export type ChangeProperties = {
  readonly location?: string;
  readonly path?: string;
  readonly ref?: string;
};

export type OadMessage = {
  readonly id: string;
  readonly code: string;
  readonly docUrl: string;
  readonly message: string;
  readonly mode: string;
  readonly type: string;
  readonly new: ChangeProperties;
  readonly old: ChangeProperties;
};

function iconFor(type: unknown) {
  if (type === "Error") {
    return ":x:";
  } else if (type === "Warning") {
    return ":warning:";
  } else if (type === "Info") {
    return ":speech_balloon:";
  } else {
    return "";
  }
}

function shortName(filePath: string) {
  return `${path.basename(
    path.dirname(filePath)
  )}/&#8203;<strong>${path.basename(filePath)}</strong>`;
}

type Diff = {
  readonly type: unknown;
  readonly id: string;
  readonly code: unknown;
  readonly message: unknown;
};

function tableLine(filePath: string, diff: Diff) {
  return `|${iconFor(diff["type"])}|[${diff["type"]} ${diff["id"]} - ${
    diff["code"]
  }](https://github.com/Azure/openapi-diff/blob/master/docs/rules/${
    diff["id"]
  }.md)|[${shortName(filePath)}](${blobHref(filePath)} "${filePath}")|${
    diff["message"]
  }|\n`;
}

function blobHref(file: string) {
  return file
    ? `https://github.com/${process.env.TRAVIS_REPO_SLUG}/blob/${process.env.TRAVIS_PULL_REQUEST_SHA}/${file}`
    : "";
}

/**
 * Compares old and new specifications for breaking change detection.
 *
 * @param oldSpec Path to the old swagger specification file.
 *
 * @param newSpec Path to the new swagger specification file.
 */
async function runOad(oldSpec: string, newSpec: string) {
  if (
    oldSpec === null ||
    oldSpec === undefined ||
    typeof oldSpec.valueOf() !== "string" ||
    !oldSpec.trim().length
  ) {
    throw new Error(
      'oldSpec is a required parameter of type "string" and it cannot be an empty string.'
    );
  }

  if (
    newSpec === null ||
    newSpec === undefined ||
    typeof newSpec.valueOf() !== "string" ||
    !newSpec.trim().length
  ) {
    throw new Error(
      'newSpec is a required parameter of type "string" and it cannot be an empty string.'
    );
  }

  console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
  console.log(`Old Spec: "${oldSpec}"`);
  console.log(`New Spec: "${newSpec}"`);
  console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);

  let result = await oad.compare(oldSpec, newSpec, { consoleLogLevel: "warn" });
  let oadResult = JSON.parse(result) as OadMessage[];

  const pipelineResultData: format.ResultMessageRecord[] = oadResult.map(
    (it) => ({
      type: "Result",
      level: it.type as format.MessageLevel,
      message: it.message,
      code: it.code,
      id: it.id,
      docUrl: it.docUrl,
      time: new Date(),
      extra: {
        mode: it.mode,
      },
      paths: [
        {
          tag: "New",
          path: blobHref(
            utils.getGithubStyleFilePath(
              utils.getRelativeSwaggerPathToRepo(it.new.location || "")
            )
          ),
        },
        {
          tag: "Old",
          path: targetHref(
            utils.getGithubStyleFilePath(
              utils.getRelativeSwaggerPathToRepo(it.old.location || "")
            )
          ),
        },
      ],
    })
  );
  const pipelineResult: format.MessageLine = pipelineResultData;

  console.log("Write to pipe.log");
  fs.appendFileSync("pipe.log", JSON.stringify(pipelineResult) + "\n");

  console.log(JSON.parse(result));

  if (!result) {
    return;
  }

  // fix up output from OAD, it does not output valid JSON
  result = result.replace(/}\s+{/gi, "},{");

  return JSON.parse(result);
}

//main function
export async function runScript() {
  console.log(`ENV: ${JSON.stringify(process.env)}`);
  // Used to enable running script outside TravisCI for debugging
  const isRunningInTravisCI = process.env.TRAVIS === "true";

  /**
   * NOTE: For base branch which not in targetBranches, the breaking change tool compare head branch with master branch.
   * TargetBranches is a set of branches and treat each of them like a service team master branch.
   */
  const targetBranches = ["master", "RPSaaSDev", "RPSaaSMaster"];

  /**
   * For PR target branch not in `targetBranches`. prepare for switch to master branch,
   * if not the switching to master below would failed
   */
  if (
    !targetBranches.includes(
      cli.defaultConfig().env.SYSTEM_PULLREQUEST_TARGETBRANCH!
    )
  ) {
    utils.setUpstreamBranch("master", "remotes/origin/master");
  }

  // create Azure DevOps PR properties.
  const pr = await devOps.createPullRequestProperties(cli.defaultConfig());

  console.log(`PR target branch is ${pr ? pr.targetBranch : ""}`);

  let targetBranch = utils.getTargetBranch();
  let swaggersToProcess = await utils.getFilesChangedInPR(pr);

  console.log("Processing swaggers:");
  console.log(swaggersToProcess);

  console.log("Finding new swaggers...");

  /*
   * always compare against master
   * we still use the changed files got from the PR, because the master branch may quite different with the PR target branch
   */
  if (pr && !targetBranches.includes(pr.targetBranch)) {
    (pr.targetBranch as string) = "master";
    console.log("switch target branch to master");
  }

  let newSwaggers: unknown[] = [];
  if (swaggersToProcess.length > 0 && pr !== undefined) {
    newSwaggers = await utils.doOnTargetBranch(pr, async () => {
      return swaggersToProcess.filter((s: string) => !fs.existsSync(s));
    });
  }

  let errorCnt = 0,
    warningCnt = 0;
  const diffFiles: stringMap.MutableStringMap<Diff[]> = {};
  const newFiles = [];

  const errors: { error: Error; old: string; new: string }[] = [];

  for (const swagger of swaggersToProcess) {
    // If file does not exists in the previous commits then we ignore it as it's new file
    if (newSwaggers.includes(swagger)) {
      console.log(`File: "${swagger}" looks to be newly added in this PR.`);
      newFiles.push(swagger);
      continue;
    }

    try {
      const diffs = await runOad(
        path.resolve(pr!.workingDir, swagger),
        swagger // Since the swagger resolving  will be done at the oad , here to ensure the position output is consistent with the origin swagger,do not use the resolved swagger
      );
      if (diffs) {
        diffFiles[swagger] = diffs;
        for (const diff of diffs) {
          if (diff["type"] === "Error") {
            if (errorCnt === 0) {
              console.log(
                `There are potential breaking changes in this PR. Please review before moving forward. Thanks!`
              );
              process.exitCode = 1;
            }
            errorCnt += 1;
          } else if (diff["type"] === "Warning") {
            warningCnt += 1;
          }
        }
      }
    } catch (err) {
      errors.push({
        error: err,
        old: targetHref(
          utils.getRelativeSwaggerPathToRepo(
            path.resolve(pr!.workingDir, swagger)
          )
        ),
        new: blobHref(utils.getRelativeSwaggerPathToRepo(swagger)),
      });
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
    const errorResult: format.MessageLine = errors.map((it) => ({
      type: "Raw",
      level: "Error",
      message: it.error.stack || "",
      time: new Date(),
      extra: {
        role: "Breaking change",
        new: it.new,
        old: it.old,
      },
    }));

    fs.appendFileSync("pipe.log", JSON.stringify(errorResult) + "\n");
    console.log(`oad error log: ${JSON.stringify(errorResult)}`);
  }

  if (isRunningInTravisCI) {
    let summary = "";
    if (errorCnt > 0) {
      summary +=
        "**There are potential breaking changes in this PR. Please review before moving forward. Thanks!**\n\n";
    }
    summary += `Compared to the target branch (**${targetBranch}**), this pull request introduces:\n\n`;
    summary += `&nbsp;&nbsp;&nbsp;${
      errorCnt > 0 ? iconFor("Error") : ":white_check_mark:"
    }&nbsp;&nbsp;&nbsp;**${errorCnt}** new error${
      errorCnt !== 1 ? "s" : ""
    }\n\n`;
    summary += `&nbsp;&nbsp;&nbsp;${
      warningCnt > 0 ? iconFor("Warning") : ":white_check_mark:"
    }&nbsp;&nbsp;&nbsp;**${warningCnt}** new warning${
      warningCnt !== 1 ? "s" : ""
    }\n\n`;

    let message = "";
    if (newFiles.length > 0) {
      message += "### The following files look to be newly added in this PR:\n";
      newFiles.sort();
      for (const swagger of newFiles) {
        message += `* [${swagger}](${blobHref(swagger)})\n`;
      }
      message += "<br><br>\n";
    }

    const diffFileNames = Object.keys(diffFiles);
    if (diffFileNames.length > 0) {
      message += "### OpenAPI diff results\n";
      message += headerText;

      diffFileNames.sort();
      for (const swagger of diffFileNames) {
        const diffs = tsUtils.asNonUndefined(diffFiles[swagger]);
        diffs.sort((a, b) => {
          if (a.type === b.type) {
            return a.id.localeCompare(b.id);
          } else if (a.type === "Error") {
            return 1;
          } else if (b.type === "Error") {
            return -1;
          } else if (a.type === "Warning") {
            return 1;
          } else {
            return -1;
          }
        });

        for (const diff of diffs) {
          message += tableLine(swagger, diff);
        }
      }
    } else {
      message += "**There were no files containing new errors or warnings.**\n";
    }

    message +=
      "\n<br><br>\nThanks for using breaking change tool to review.\nIf you encounter any issue(s), please open issue(s) at https://github.com/Azure/openapi-diff/issues.";

    const output = {
      title: `${errorCnt === 0 ? "No" : errorCnt} potential breaking change${
        errorCnt !== 1 ? "s" : ""
      }`,
      summary,
      text: message,
    };

    console.log("---output");
    console.log(output);
    console.log("---");
  }
}
