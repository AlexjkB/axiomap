// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Neither of these resolves. Import resolution must record the failure, mark
// dependent edges `unresolved`, and keep going (§4).
import {Missing} from "@nonexistent/package/Missing.sol";
import "./does/not/exist/Ghost.sol";

import {Assembly} from "./Assembly.sol";

contract BadImport {
    Assembly public real;
    Missing public phantom;

    function poke() external view returns (uint256) {
        return real.slot0();
    }
}
