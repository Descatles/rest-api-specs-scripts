// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License in the project root for license information.

import { suite, test, slow, timeout, skip, only } from "mocha-typescript";
import {getLinterResult} from '../momentOfTruth'
import * as assert from "assert";

@suite class MomentOfTruthTest {
    
    /**
     * test if the lint tool run normally
     */
    @test @timeout(60000) async "TestGetLinterResult" () {
      
      process.env.CLASSIC_LINT_VERSION = "1.1.0"
      process.env.LINT_VERSION = "1.1.0"
      let result = await getLinterResult("./src/tests/Resource/swagger/test-lint-result.md");
      assert.equal(Object.keys(result).length,3)
    }

}
