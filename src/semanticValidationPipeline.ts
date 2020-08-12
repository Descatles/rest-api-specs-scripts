// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License in the project root for license information.

import { devOps, cli } from '@azure/avocado'
import { FilePosition } from "@ts-common/source-map"
import * as utils from './utils'
import * as oav from 'oav'
import * as format from "@azure/swagger-validation-common";
import * as fs from "fs-extra";

function getDocUrl(id: string | undefined) {
  return `https://github.com/Azure/azure-rest-api-specs/blob/master/documentation/Semantic-and-Model-Violations-Reference.md#${id}`;
}

interface ValidationError {
  validationCategory: string
  code?: string
  providerNamespace: unknown
  type: string
  inner?: oav.CommonError | oav.CommonError[]
  id?: unknown
  message?: string
  jsonref?: string
  "json-path"?: string
  jsonUrl?: string
  jsonPosition?: FilePosition
}

interface ValidationEntry {
  code: string
  error: string
  errors: ValidationEntry[] //for nested errors
  lineage: string[]
  message: string
  name: string
  params: Object[]
  path: string[]
  schemaPath: string
  schemaId: string
}

function constructBaseResultData(level: string, error: ValidationError | ValidationEntry): format.ResultMessageRecord {
  let pipelineResultData: format.ResultMessageRecord = {
    type: "Result",
    level: level as format.MessageLevel,
    message: error.message || "",
    code: error.code || "",
    docUrl: getDocUrl(error.code),
    time: new Date(),
    extra: { },
    paths:[]
  }
  return pipelineResultData;
}

export async function main() {
  const pr = await devOps.createPullRequestProperties(cli.defaultConfig())
  let swaggersToProcess = await utils.getFilesChangedInPR(pr);
  swaggersToProcess = swaggersToProcess.filter(function (item) {
    // Useful when debugging a test for a particular swagger.
    // Just update the regex. That will return an array of filtered items.
    //   return (item.match(/.*Microsoft.Logic.*2016-06-01.*/ig) !== null);
    return (item.match(/.*specification\/.*/ig) !== null);
  });
  let exitCode: number = 0;
  let specValidationResult;
  for (const swagger of swaggersToProcess) {
    try {
      const validator = new oav.SemanticValidator(swagger, null,
        {consoleLogLevel: 'error',
        shouldResolveDiscriminator : false,
        shouldResolveParameterizedHost : false,
        shouldResolveNullableTypes: false});
      await validator.initialize();

      console.log(`Semantically validating  ${swagger}:\n`);
      await validator.validateSpec();

      if (validator.specValidationResult.resolveSpec) {
        const resolveSpecError = validator.specValidationResult.resolveSpec;
        const pipelineResultError = constructBaseResultData("Error", resolveSpecError);
        fs.appendFileSync("pipe.log", JSON.stringify(pipelineResultError) + "\n");
        exitCode = 1;
      } else if (validator.specValidationResult.validateSpec) {
        const validateSpec = validator.specValidationResult.validateSpec;
        if (!validateSpec.isValid) {
          const validateSpecWarnings = validateSpec.warnings as ValidationError[];
          const pipelineResultWarnings: format.ResultMessageRecord[] = validateSpecWarnings.map(function(it) {
            let pipelineResultWarning = constructBaseResultData("Warning", it);
            if (it.jsonUrl && it.jsonPosition) pipelineResultWarning.paths.push(
              {
                tag: "JsonUrl",
                path: utils.blobHref(
                  utils.getGithubStyleFilePath(
                    utils.getRelativeSwaggerPathToRepo(it.jsonUrl + '#L' + String(it.jsonPosition.line) || "")
                  )
                )
              }
            )
            return pipelineResultWarning;
          });

          if (pipelineResultWarnings.length > 0) {
            fs.appendFileSync("pipe.log", JSON.stringify(pipelineResultWarnings) + "\n");
          }

          const validateSpecErrors = validateSpec.errors as ValidationError[];
          const pipelineResultErrors: format.ResultMessageRecord[] = validateSpecErrors.map(function(it) {
            let pipelineResultError = constructBaseResultData("Error", it);
            if (it.jsonUrl && it.jsonPosition) pipelineResultError.paths.push(
              {
                tag: "JsonUrl",
                path: utils.blobHref(
                  utils.getGithubStyleFilePath(
                    utils.getRelativeSwaggerPathToRepo(it.jsonUrl + '#L' + String(it.jsonPosition.line) || "")
                  )
                )
              }
            )
            return pipelineResultError;
          });
          if (pipelineResultErrors.length > 0) {
            fs.appendFileSync("pipe.log", JSON.stringify(pipelineResultErrors) + "\n");
          }
          exitCode = 1;
        }
      }
    } catch (e) {
      console.error("error: ")
      console.error(e)
      exitCode = 1
    }
  }
  process.exitCode = exitCode;
}
