import type { Address } from "@solana/kit";

/**
 * Exact SVM payload structure containing a base64 encoded Solana transaction
 */
export type ExactSvmPayloadV1 = {
  /**
   * Base64 encoded Solana transaction
   */
  transaction: string;
};

/**
 * Exact SVM payload V2 structure (currently same as V1, reserved for future extensions)
 */
export type ExactSvmPayloadV2 = ExactSvmPayloadV1;

/**
 * Instruction structure passed to custom verifiers
 */
export interface VerifiableInstruction {
  programAddress: Address;
  accounts?: readonly { address: Address; role: number }[];
  data?: Readonly<Uint8Array>;
}

/**
 * Context provided to custom instruction verifiers
 */
export interface InstructionVerifierContext {
  /** Addresses managed by the facilitator's signer */
  signerAddresses: Address[];
  /** The fee payer address for this transaction */
  feePayer: Address;
  /** The index of this instruction in the transaction */
  instructionIndex: number;
}

/**
 * Custom instruction verifier function
 *
 * @param instruction - The decompiled instruction to verify
 * @param context - Verification context (signerAddresses, feePayer, etc.)
 * @throws Error with invalidReason if verification fails
 */
export type InstructionVerifier = (
  instruction: VerifiableInstruction,
  context: InstructionVerifierContext,
) => void;

/**
 * Configuration for custom instruction verification
 */
export interface InstructionVerifierConfig {
  /**
   * Program ID(s) this verifier handles
   * Can be a single address or array of addresses
   */
  programIds: Address[];

  /**
   * Optional: Allowed position(s) for this instruction
   * If set, instruction must appear at one of these indices
   * If not set, instruction can appear at any position
   */
  allowedPositions?: number[];

  /**
   * Custom verification function
   * If not provided, defaults to "allow if programId matches"
   *
   * @throws Error with reason if verification fails
   */
  verify?: InstructionVerifier;
}

/**
 * Configuration for SVM transaction verification behavior
 *
 * This allows facilitators to customize verification beyond the default
 * strict 3-instruction mode (ComputeLimit + ComputePrice + TransferChecked).
 *
 * @example
 * // Phantom Lighthouse support
 * {
 *   allowAdditionalInstructions: true,
 *   maxInstructionCount: 4,
 *   allowedProgramIds: ["L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"],
 * }
 *
 * @example
 * // Memo and Lighthouse program support with custom verifiers
 * {
 *   allowAdditionalInstructions: true,
 *   maxInstructionCount: 5,
 *   customVerifiers: [
 *    {
 *     programIds: ["Lighthouse..."],
 *     allowedPositions: [3,4],
 *     // Custom verification function (optional)
 *     // verify: (ix, ctx) => { ... },
 *   }
 *    {
 *     programIds: ["Memo..."],
 *     allowedPositions: [3,4],
 *     // Custom verification function (optional)
 *     // verify: (ix, ctx) => { ... },
 *   }],
 * }
 */
export interface SvmVerificationConfig {
  /**
   * Maximum number of instructions allowed in a transaction
   * Default: 3 (ComputeLimit + ComputePrice + TransferChecked)
   */
  maxInstructionCount?: number;

  /**
   * Allow additional instructions beyond the required ones
   * (ComputeLimit, ComputePrice, TransferChecked)
   *
   * If true, additional instructions are allowed subject to:
   * - maxInstructionCount limit
   * - allowedProgramIds whitelist (if set)
   * - blockedProgramIds blacklist
   * - customVerifiers (if matching)
   *
   * Default: false
   */
  allowAdditionalInstructions?: boolean;

  /**
   * Explicitly allowed program IDs for additional instructions
   * Only checked if allowAdditionalInstructions is true
   *
   * If set, additional instructions must use one of these program IDs
   * (unless handled by a customVerifier)
   */
  allowedProgramIds?: string[];

  /**
   * Blocked program IDs (always rejected, takes precedence over allowed)
   * Instructions using these programs will always fail verification
   */
  blockedProgramIds?: string[];

  /**
   * Custom verifiers for specific program IDs
   * These take precedence over allowedProgramIds for matching programs
   */
  customVerifiers?: InstructionVerifierConfig[];

  /**
   * SECURITY: Require fee payer is NOT present in any instruction's accounts
   * This prevents the facilitator from being tricked into signing
   * transactions that could drain their funds.
   *
   * Default: true - strongly recommended to keep this enabled
   */
  requireFeePayerNotInInstructions?: boolean;
}
