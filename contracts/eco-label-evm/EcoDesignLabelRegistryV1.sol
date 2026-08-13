// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.4.0;

/// @title EcoDesignLabelRegistryV1
/// @notice Atomic rule governance and eco-design identifier lifecycle registry.
/// @dev AntChain-modified Solidity 0.4.x source. Scores, grades,
/// indicator values, BOM data and evidence content never enter this contract.
contract EcoDesignLabelRegistryV1 {
    bytes32 public constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 public constant ALGORITHM_ADMIN_ROLE =
        0x005ea7a03405acd03b2b290c52617c05c91cb93c01a000650bc4ea31691042c97a;
    bytes32 public constant LABEL_ISSUER_ROLE =
        0x005945ecd7fdd59461001ba06fd78c9ad364121d418d5725cfefd953531707538b;
    bytes32 public constant LABEL_LIFECYCLE_ROLE =
        0x0032ce96414b18c561f66b1113b67ee17a765bd302544f62198f2cf20604ef982a;

    enum AlgorithmStatus { NONE, DRAFT, ACTIVE, SUSPENDED, RETIRED }
    enum LabelStatus { NONE, ACTIVE, SUSPENDED, SUPERSEDED, REVOKED, EXPIRED }

    struct AlgorithmRecord {
        string algorithmId;
        string schemeId;
        string version;
        bytes32 algorithmHash;
        bytes32 evaluatorHash;
        AlgorithmStatus status;
        identity publisher;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    struct LabelRecord {
        string labelId;
        string taskId;
        string algorithmId;
        bytes32 algorithmHash;
        bytes32 inputHash;
        bytes32 resultHash;
        bytes32 evidenceHash;
        bytes32 authorizationHash;
        bytes32 proofHash;
        LabelStatus status;
        identity issuer;
        uint64 issuedAt;
        uint64 updatedAt;
        uint64 expiresAt;
        string previousLabelId;
        string replacedByLabelId;
        bytes32 payloadDigest;
    }

    struct IssueRequest {
        string labelId;
        string taskId;
        string algorithmId;
        bytes32 algorithmHash;
        bytes32 inputHash;
        bytes32 resultHash;
        bytes32 evidenceHash;
        bytes32 authorizationHash;
        bytes32 proofHash;
        uint64 expiresAt;
    }

    // A deterministic composite key keeps each role/account assignment in one
    // platform mapping while preserving the exact authorization relation.
    mapping(bytes32 => bool) private roles;
    mapping(bytes32 => AlgorithmRecord) private algorithms;
    mapping(bytes32 => bytes32) private activeAlgorithmByScheme;
    mapping(bytes32 => LabelRecord) private labels;
    mapping(bytes32 => bytes32) private labelByTask;

    event RoleGranted(bytes32 indexed role, identity indexed account, identity indexed sender);
    event RoleRevoked(bytes32 indexed role, identity indexed account, identity indexed sender);
    event AlgorithmRegistered(
        bytes32 indexed algorithmKey,
        bytes32 indexed schemeKey,
        string algorithmId,
        string schemeId,
        string version,
        bytes32 algorithmHash,
        bytes32 evaluatorHash,
        identity publisher
    );
    event AlgorithmStatusChanged(
        bytes32 indexed algorithmKey,
        string algorithmId,
        uint8 previousStatus,
        uint8 newStatus,
        identity actor
    );
    event LabelIssued(
        bytes32 indexed labelKey,
        bytes32 indexed taskKey,
        bytes32 indexed algorithmKey,
        string labelId,
        string taskId,
        bytes32 payloadDigest,
        bytes32 resultHash,
        identity issuer
    );
    event LabelStatusChanged(
        bytes32 indexed labelKey,
        string labelId,
        uint8 previousStatus,
        uint8 newStatus,
        identity actor
    );
    event LabelSuperseded(
        bytes32 indexed previousLabelKey,
        bytes32 indexed newLabelKey,
        string previousLabelId,
        string newLabelId,
        identity actor
    );

    modifier onlyRole(bytes32 role) {
        require(roles[roleAssignmentKey(role, msg.sender)], "ACCESS_DENIED");
        _;
    }

    constructor() public {
        grantRoleInternal(DEFAULT_ADMIN_ROLE, msg.sender);
        grantRoleInternal(ALGORITHM_ADMIN_ROLE, msg.sender);
        grantRoleInternal(LABEL_ISSUER_ROLE, msg.sender);
        grantRoleInternal(LABEL_LIFECYCLE_ROLE, msg.sender);
    }

    function hasRole(bytes32 role, identity account) public view returns (bool) {
        return roles[roleAssignmentKey(role, account)];
    }

    function grantRole(bytes32 role, identity account)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(account != identity(0), "INVALID_ACCOUNT");
        grantRoleInternal(role, account);
    }

    function revokeRole(bytes32 role, identity account)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        bytes32 assignmentKey = roleAssignmentKey(role, account);
        if (roles[assignmentKey]) {
            roles[assignmentKey] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function registerAlgorithm(
        string algorithmId,
        string schemeId,
        string version,
        bytes32 algorithmHash,
        bytes32 evaluatorHash
    ) public onlyRole(ALGORITHM_ADMIN_ROLE) returns (bytes32 algorithmKey) {
        requireIdentifier(algorithmId);
        requireIdentifier(schemeId);
        requireIdentifier(version);
        requireCommitment(algorithmHash);
        requireCommitment(evaluatorHash);

        algorithmKey = keyOf(algorithmId);
        AlgorithmRecord storage existing = algorithms[algorithmKey];
        if (existing.status != AlgorithmStatus.NONE) {
            require(
                equal(existing.schemeId, schemeId) &&
                equal(existing.version, version) &&
                existing.algorithmHash == algorithmHash &&
                existing.evaluatorHash == evaluatorHash &&
                existing.publisher == msg.sender,
                "ALGORITHM_CONFLICT"
            );
            return algorithmKey;
        }

        uint64 timestamp = uint64(block.timestamp);
        algorithms[algorithmKey] = AlgorithmRecord(
            algorithmId,
            schemeId,
            version,
            algorithmHash,
            evaluatorHash,
            AlgorithmStatus.DRAFT,
            msg.sender,
            timestamp,
            timestamp
        );
        emit AlgorithmRegistered(
            algorithmKey,
            keyOf(schemeId),
            algorithmId,
            schemeId,
            version,
            algorithmHash,
            evaluatorHash,
            msg.sender
        );
    }

    function activateAlgorithm(string algorithmId)
        public
        onlyRole(ALGORITHM_ADMIN_ROLE)
    {
        bytes32 algorithmKey = keyOf(algorithmId);
        AlgorithmRecord storage record = requireAlgorithm(algorithmKey);
        require(record.status != AlgorithmStatus.RETIRED, "ALGORITHM_RETIRED");
        if (record.status == AlgorithmStatus.ACTIVE) return;

        bytes32 schemeKey = keyOf(record.schemeId);
        bytes32 previousKey = activeAlgorithmByScheme[schemeKey];
        if (previousKey != bytes32(0) && previousKey != algorithmKey) {
            AlgorithmRecord storage previous = algorithms[previousKey];
            AlgorithmStatus previousStatus = previous.status;
            previous.status = AlgorithmStatus.SUSPENDED;
            previous.updatedAt = uint64(block.timestamp);
            emit AlgorithmStatusChanged(
                previousKey,
                previous.algorithmId,
                uint8(previousStatus),
                uint8(AlgorithmStatus.SUSPENDED),
                msg.sender
            );
        }

        AlgorithmStatus oldStatus = record.status;
        record.status = AlgorithmStatus.ACTIVE;
        record.updatedAt = uint64(block.timestamp);
        activeAlgorithmByScheme[schemeKey] = algorithmKey;
        emit AlgorithmStatusChanged(
            algorithmKey,
            record.algorithmId,
            uint8(oldStatus),
            uint8(AlgorithmStatus.ACTIVE),
            msg.sender
        );
    }

    function suspendAlgorithm(string algorithmId)
        public
        onlyRole(ALGORITHM_ADMIN_ROLE)
    {
        bytes32 algorithmKey = keyOf(algorithmId);
        AlgorithmRecord storage record = requireAlgorithm(algorithmKey);
        require(record.status != AlgorithmStatus.RETIRED, "ALGORITHM_RETIRED");
        if (record.status == AlgorithmStatus.SUSPENDED) return;
        AlgorithmStatus oldStatus = record.status;
        record.status = AlgorithmStatus.SUSPENDED;
        record.updatedAt = uint64(block.timestamp);
        bytes32 schemeKey = keyOf(record.schemeId);
        if (activeAlgorithmByScheme[schemeKey] == algorithmKey) {
            delete activeAlgorithmByScheme[schemeKey];
        }
        emit AlgorithmStatusChanged(
            algorithmKey,
            record.algorithmId,
            uint8(oldStatus),
            uint8(AlgorithmStatus.SUSPENDED),
            msg.sender
        );
    }

    function retireAlgorithm(string algorithmId)
        public
        onlyRole(ALGORITHM_ADMIN_ROLE)
    {
        bytes32 algorithmKey = keyOf(algorithmId);
        AlgorithmRecord storage record = requireAlgorithm(algorithmKey);
        if (record.status == AlgorithmStatus.RETIRED) return;
        AlgorithmStatus oldStatus = record.status;
        record.status = AlgorithmStatus.RETIRED;
        record.updatedAt = uint64(block.timestamp);
        bytes32 schemeKey = keyOf(record.schemeId);
        if (activeAlgorithmByScheme[schemeKey] == algorithmKey) {
            delete activeAlgorithmByScheme[schemeKey];
        }
        emit AlgorithmStatusChanged(
            algorithmKey,
            record.algorithmId,
            uint8(oldStatus),
            uint8(AlgorithmStatus.RETIRED),
            msg.sender
        );
    }

    function getAlgorithm(string algorithmId)
        public
        view
        returns (
            string schemeId,
            string version,
            bytes32 algorithmHash,
            bytes32 evaluatorHash,
            uint8 status,
            identity publisher,
            uint64 registeredAt,
            uint64 updatedAt
        )
    {
        AlgorithmRecord storage record = requireAlgorithm(keyOf(algorithmId));
        return (
            record.schemeId,
            record.version,
            record.algorithmHash,
            record.evaluatorHash,
            uint8(record.status),
            record.publisher,
            record.registeredAt,
            record.updatedAt
        );
    }

    function getActiveAlgorithmId(string schemeId)
        public
        view
        returns (string)
    {
        bytes32 activeKey = activeAlgorithmByScheme[keyOf(schemeId)];
        if (activeKey == bytes32(0)) return "";
        return algorithms[activeKey].algorithmId;
    }

    function isAlgorithmActive(string algorithmId, bytes32 algorithmHash)
        public
        view
        returns (bool)
    {
        bytes32 algorithmKey = keyOf(algorithmId);
        AlgorithmRecord storage record = algorithms[algorithmKey];
        return
            record.status == AlgorithmStatus.ACTIVE &&
            record.algorithmHash == algorithmHash &&
            activeAlgorithmByScheme[keyOf(record.schemeId)] == algorithmKey;
    }

    function issueLabel(
        string labelId,
        string taskId,
        string algorithmId,
        bytes32 algorithmHash,
        bytes32 inputHash,
        bytes32 resultHash,
        bytes32 evidenceHash,
        bytes32 authorizationHash,
        bytes32 proofHash,
        uint64 expiresAt
    ) public onlyRole(LABEL_ISSUER_ROLE) returns (bytes32) {
        IssueRequest memory request;
        request.labelId = labelId;
        request.taskId = taskId;
        request.algorithmId = algorithmId;
        request.algorithmHash = algorithmHash;
        request.inputHash = inputHash;
        request.resultHash = resultHash;
        request.evidenceHash = evidenceHash;
        request.authorizationHash = authorizationHash;
        request.proofHash = proofHash;
        request.expiresAt = expiresAt;
        return issueLabelInternal(request, "");
    }

    function suspendLabel(string labelId)
        public
        onlyRole(LABEL_LIFECYCLE_ROLE)
    {
        changeLabelStatus(labelId, LabelStatus.ACTIVE, LabelStatus.SUSPENDED);
    }

    function resumeLabel(string labelId)
        public
        onlyRole(LABEL_LIFECYCLE_ROLE)
    {
        changeLabelStatus(labelId, LabelStatus.SUSPENDED, LabelStatus.ACTIVE);
    }

    function revokeLabel(string labelId, bytes32 reasonHash)
        public
        onlyRole(LABEL_LIFECYCLE_ROLE)
    {
        requireCommitment(reasonHash);
        bytes32 labelKey = keyOf(labelId);
        LabelRecord storage record = requireLabel(labelKey);
        if (record.status == LabelStatus.REVOKED) return;
        require(
            record.status != LabelStatus.SUPERSEDED &&
            record.status != LabelStatus.EXPIRED,
            "INVALID_TRANSITION"
        );
        LabelStatus oldStatus = record.status;
        record.status = LabelStatus.REVOKED;
        record.updatedAt = uint64(block.timestamp);
        emit LabelStatusChanged(
            labelKey,
            labelId,
            uint8(oldStatus),
            uint8(LabelStatus.REVOKED),
            msg.sender
        );
    }

    function expireLabel(string labelId) public {
        bytes32 labelKey = keyOf(labelId);
        LabelRecord storage record = requireLabel(labelKey);
        if (record.status == LabelStatus.EXPIRED) return;
        require(
            record.expiresAt != 0 && block.timestamp >= record.expiresAt,
            "LABEL_NOT_EXPIRED"
        );
        require(
            record.status == LabelStatus.ACTIVE ||
            record.status == LabelStatus.SUSPENDED,
            "INVALID_TRANSITION"
        );
        LabelStatus oldStatus = record.status;
        record.status = LabelStatus.EXPIRED;
        record.updatedAt = uint64(block.timestamp);
        emit LabelStatusChanged(
            labelKey,
            labelId,
            uint8(oldStatus),
            uint8(LabelStatus.EXPIRED),
            msg.sender
        );
    }

    /// @notice Links an already-issued replacement to an earlier label.
    /// @dev The platform's 0.4.x compiler cannot compile the former large tuple entry
    /// point. Issuance remains idempotent, and this link operation is separately
    /// idempotent so a coordinator can recover either transaction by readback.
    function supersedeLabel(string previousLabelId, string newLabelId)
        public
        onlyRole(LABEL_ISSUER_ROLE)
    {
        bytes32 previousKey = keyOf(previousLabelId);
        LabelRecord storage previous = requireLabel(previousKey);
        bytes32 newKey = keyOf(newLabelId);
        LabelRecord storage replacement = requireLabel(newKey);
        require(previousKey != newKey, "INVALID_REPLACEMENT");
        if (previous.status == LabelStatus.SUPERSEDED) {
            require(equal(previous.replacedByLabelId, newLabelId), "INVALID_TRANSITION");
            require(equal(replacement.previousLabelId, previousLabelId), "INVALID_TRANSITION");
            return;
        }
        require(
            previous.status == LabelStatus.ACTIVE ||
            previous.status == LabelStatus.SUSPENDED,
            "INVALID_TRANSITION"
        );
        require(replacement.status == LabelStatus.ACTIVE, "INVALID_REPLACEMENT");
        require(
            bytes(replacement.previousLabelId).length == 0 ||
            equal(replacement.previousLabelId, previousLabelId),
            "REPLACEMENT_ALREADY_LINKED"
        );
        LabelStatus oldStatus = previous.status;
        previous.status = LabelStatus.SUPERSEDED;
        previous.updatedAt = uint64(block.timestamp);
        previous.replacedByLabelId = newLabelId;
        replacement.previousLabelId = previousLabelId;
        replacement.updatedAt = uint64(block.timestamp);
        emit LabelStatusChanged(
            previousKey,
            previousLabelId,
            uint8(oldStatus),
            uint8(LabelStatus.SUPERSEDED),
            msg.sender
        );
        emit LabelSuperseded(
            previousKey,
            newKey,
            previousLabelId,
            newLabelId,
            msg.sender
        );
    }

    function getLabel(string labelId)
        public
        view
        returns (
            string taskId,
            string algorithmId,
            uint8 status,
            bytes32 resultHash,
            bytes32 payloadDigest,
            bytes32 recordDigest
        )
    {
        LabelRecord storage record = requireLabel(keyOf(labelId));
        return labelSummary(record);
    }

    function getLabelByTaskId(string taskId)
        public
        view
        returns (
            string labelId,
            string algorithmId,
            uint8 status,
            bytes32 resultHash,
            bytes32 payloadDigest,
            bytes32 recordDigest
        )
    {
        bytes32 labelKey = labelByTask[keyOf(taskId)];
        LabelRecord storage record = requireLabel(labelKey);
        return (
            record.labelId,
            record.algorithmId,
            uint8(record.status),
            record.resultHash,
            record.payloadDigest,
            labelRecordDigest(record)
        );
    }

    function getLabelCommitments(string labelId)
        public
        view
        returns (
            bytes32 algorithmHash,
            bytes32 inputHash,
            bytes32 resultHash,
            bytes32 evidenceHash,
            bytes32 authorizationHash,
            bytes32 proofHash
        )
    {
        LabelRecord storage record = requireLabel(keyOf(labelId));
        return (
            record.algorithmHash,
            record.inputHash,
            record.resultHash,
            record.evidenceHash,
            record.authorizationHash,
            record.proofHash
        );
    }

    function getLabelLifecycle(string labelId)
        public
        view
        returns (
            identity issuer,
            uint64 issuedAt,
            uint64 updatedAt,
            uint64 expiresAt,
            string previousLabelId,
            string replacedByLabelId
        )
    {
        LabelRecord storage record = requireLabel(keyOf(labelId));
        return (
            record.issuer,
            record.issuedAt,
            record.updatedAt,
            record.expiresAt,
            record.previousLabelId,
            record.replacedByLabelId
        );
    }

    function issueLabelInternal(IssueRequest memory request, string previousLabelId)
        internal
        returns (bytes32 payloadDigest)
    {
        requireIdentifier(request.labelId);
        requireIdentifier(request.taskId);
        requireIdentifier(request.algorithmId);
        requireCommitment(request.algorithmHash);
        requireCommitment(request.inputHash);
        requireCommitment(request.resultHash);
        requireCommitment(request.evidenceHash);
        requireCommitment(request.authorizationHash);
        requireCommitment(request.proofHash);
        require(
            request.expiresAt == 0 || request.expiresAt > block.timestamp,
            "INVALID_EXPIRY"
        );

        bytes32 algorithmKey = keyOf(request.algorithmId);
        AlgorithmRecord storage algorithm = requireAlgorithm(algorithmKey);
        require(
            algorithm.status == AlgorithmStatus.ACTIVE &&
            algorithm.algorithmHash == request.algorithmHash &&
            activeAlgorithmByScheme[keyOf(algorithm.schemeId)] == algorithmKey,
            "ALGORITHM_NOT_ACTIVE"
        );

        bytes32 labelKey = keyOf(request.labelId);
        bytes32 taskKey = keyOf(request.taskId);
        payloadDigest = issuePayloadDigest(request, previousLabelId, msg.sender);
        LabelRecord storage existing = labels[labelKey];
        if (existing.status != LabelStatus.NONE) {
            require(
                existing.payloadDigest == payloadDigest &&
                labelByTask[taskKey] == labelKey,
                "LABEL_CONFLICT"
            );
            return existing.payloadDigest;
        }
        require(labelByTask[taskKey] == bytes32(0), "TASK_CONFLICT");

        uint64 timestamp = uint64(block.timestamp);
        labels[labelKey] = LabelRecord(
            request.labelId,
            request.taskId,
            request.algorithmId,
            request.algorithmHash,
            request.inputHash,
            request.resultHash,
            request.evidenceHash,
            request.authorizationHash,
            request.proofHash,
            LabelStatus.ACTIVE,
            msg.sender,
            timestamp,
            timestamp,
            request.expiresAt,
            previousLabelId,
            "",
            payloadDigest
        );
        labelByTask[taskKey] = labelKey;
        emit LabelIssued(
            labelKey,
            taskKey,
            algorithmKey,
            request.labelId,
            request.taskId,
            payloadDigest,
            request.resultHash,
            msg.sender
        );
    }

    function changeLabelStatus(
        string labelId,
        LabelStatus requiredStatus,
        LabelStatus nextStatus
    ) internal {
        bytes32 labelKey = keyOf(labelId);
        LabelRecord storage record = requireLabel(labelKey);
        if (record.status == nextStatus) return;
        require(record.status == requiredStatus, "INVALID_TRANSITION");
        LabelStatus oldStatus = record.status;
        record.status = nextStatus;
        record.updatedAt = uint64(block.timestamp);
        emit LabelStatusChanged(
            labelKey,
            labelId,
            uint8(oldStatus),
            uint8(nextStatus),
            msg.sender
        );
    }

    function requireAlgorithm(bytes32 algorithmKey)
        internal
        view
        returns (AlgorithmRecord storage record)
    {
        record = algorithms[algorithmKey];
        require(record.status != AlgorithmStatus.NONE, "ALGORITHM_NOT_FOUND");
    }

    function requireLabel(bytes32 labelKey)
        internal
        view
        returns (LabelRecord storage record)
    {
        record = labels[labelKey];
        require(record.status != LabelStatus.NONE, "LABEL_NOT_FOUND");
    }

    function labelSummary(LabelRecord storage record)
        internal
        view
        returns (string, string, uint8, bytes32, bytes32, bytes32)
    {
        return (
            record.taskId,
            record.algorithmId,
            uint8(record.status),
            record.resultHash,
            record.payloadDigest,
            labelRecordDigest(record)
        );
    }

    function labelRecordDigest(LabelRecord storage record)
        internal
        view
        returns (bytes32)
    {
        bytes32 identityDigest = keccak256(abi.encodePacked(
            keyOf(record.labelId),
            keyOf(record.taskId),
            keyOf(record.algorithmId),
            record.algorithmHash,
            record.inputHash,
            record.resultHash,
            record.evidenceHash,
            record.authorizationHash,
            record.proofHash
        ));
        bytes32 lifecycleDigest = keccak256(abi.encodePacked(
            uint8(record.status),
            record.issuer,
            record.issuedAt,
            record.updatedAt,
            record.expiresAt,
            keyOf(record.previousLabelId),
            keyOf(record.replacedByLabelId),
            record.payloadDigest
        ));
        return keccak256(abi.encodePacked(identityDigest, lifecycleDigest));
    }

    function issuePayloadDigest(
        IssueRequest memory request,
        string previousLabelId,
        identity issuer
    ) internal pure returns (bytes32) {
        bytes32 identityDigest = keccak256(abi.encodePacked(
            keyOf(request.labelId),
            keyOf(request.taskId),
            keyOf(request.algorithmId),
            request.algorithmHash,
            request.inputHash,
            request.resultHash,
            request.evidenceHash
        ));
        bytes32 authorityDigest = keccak256(abi.encodePacked(
            request.authorizationHash,
            request.proofHash,
            request.expiresAt,
            keyOf(previousLabelId),
            issuer
        ));
        return keccak256(abi.encodePacked(identityDigest, authorityDigest));
    }

    function grantRoleInternal(bytes32 role, identity account) internal {
        bytes32 assignmentKey = roleAssignmentKey(role, account);
        if (!roles[assignmentKey]) {
            roles[assignmentKey] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function roleAssignmentKey(bytes32 role, identity account)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(role, account));
    }

    function requireIdentifier(string value) internal pure {
        uint256 length = bytes(value).length;
        require(length > 0 && length <= 128, "INVALID_IDENTIFIER");
    }

    function requireCommitment(bytes32 value) internal pure {
        require(value != bytes32(0), "INVALID_COMMITMENT");
    }

    function keyOf(string value) internal pure returns (bytes32) {
        return keccak256(bytes(value));
    }

    function equal(string left, string right) internal pure returns (bool) {
        return keccak256(bytes(left)) == keccak256(bytes(right));
    }
}
