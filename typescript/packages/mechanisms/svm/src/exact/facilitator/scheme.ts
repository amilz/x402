import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  parseTransferCheckedInstruction as parseTransferCheckedInstructionToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  findAssociatedTokenPda,
  parseTransferCheckedInstruction as parseTransferCheckedInstruction2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  type Address,
  type CompiledTransactionMessage,
} from "@solana/kit";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS } from "../../constants";
import type { FacilitatorSvmSigner } from "../../signer";
import type {
  ExactSvmPayloadV2,
  InstructionVerifierContext,
  SvmVerificationConfig,
  VerifiableInstruction,
} from "../../types";
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from "../../utils";

/**
 * Result of instruction validation
 */
interface InstructionValidationResult {
  isValid: boolean;
  reason?: string;
  /** Index of the transfer instruction in the transaction */
  transferInstructionIndex: number;
}

/**
 * Default verification configuration for the ExactSvmScheme.
 */
const DEFAULT_VERIFICATION_CONFIG: Required<SvmVerificationConfig> = {
  allowAdditionalInstructions: false,
  maxInstructionCount: 3,
  allowedProgramIds: [],
  blockedProgramIds: [],
  customVerifiers: [],
  requireFeePayerNotInInstructions: true,
};

/**
 * SVM facilitator implementation for the Exact payment scheme.
 */
export class ExactSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "solana:*";

  /**
   * Creates a new ExactSvmFacilitator instance.
   *
   * @param signer - The SVM signer for facilitator operations
   * @param verificationConfig - Optional configuration for transaction verification
   * @returns ExactSvmFacilitator instance
   */
  constructor(
    private readonly signer: FacilitatorSvmSigner,
    private readonly verificationConfig: SvmVerificationConfig = {},
  ) {}

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For SVM, this includes a randomly selected fee payer address.
   * Random selection distributes load across multiple signers.
   *
   * @param _ - The network identifier (unused for SVM)
   * @returns Extra data with feePayer address
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    // Randomly select from available signers to distribute load
    const addresses = this.signer.getAddresses();
    const randomIndex = Math.floor(Math.random() * addresses.length);

    return {
      feePayer: addresses[randomIndex],
    };
  }

  /**
   * Get signer addresses used by this facilitator.
   * For SVM, returns all available fee payer addresses.
   *
   * @param _ - The network identifier (unused for SVM)
   * @returns Array of fee payer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const exactSvmPayload = payload.payload as ExactSvmPayloadV2;

    // Step 1: Validate Payment Requirements
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return {
        isValid: false,
        invalidReason: "unsupported_scheme",
        payer: "",
      };
    }

    if (payload.accepted.network !== requirements.network) {
      return {
        isValid: false,
        invalidReason: "network_mismatch",
        payer: "",
      };
    }

    if (!requirements.extra?.feePayer || typeof requirements.extra.feePayer !== "string") {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_missing_fee_payer",
        payer: "",
      };
    }

    // Verify that the requested feePayer is managed by this facilitator
    const signerAddresses = this.signer.getAddresses().map(addr => addr.toString());
    if (!signerAddresses.includes(requirements.extra.feePayer)) {
      return {
        isValid: false,
        invalidReason: "fee_payer_not_managed_by_facilitator",
        payer: "",
      };
    }

    // Step 2: Parse and Validate Transaction Structure
    let transaction;
    try {
      transaction = decodeTransactionFromPayload(exactSvmPayload);
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_could_not_be_decoded",
        payer: "",
      };
    }

    const compiled = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    ) as CompiledTransactionMessage;
    const decompiled = decompileTransactionMessage(compiled);
    const instructions = decompiled.instructions ?? [];

    const payer = getTokenPayerFromTransaction(transaction);
    if (!payer) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
        payer: "",
      };
    }

    // Step 3: Validate instruction structure (flexible based on config)
    const validationResult = this.validateInstructions(
      instructions as never,
      signerAddresses,
      requirements.extra.feePayer,
    );

    if (!validationResult.isValid) {
      return {
        isValid: false,
        invalidReason: validationResult.reason ?? "invalid_instructions",
        payer,
      };
    }

    // Step 4: Verify Transfer Instruction
    const transferIx = instructions[validationResult.transferInstructionIndex];
    const programAddress = transferIx.programAddress.toString();

    if (
      programAddress !== TOKEN_PROGRAM_ADDRESS.toString() &&
      programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
        payer,
      };
    }

    // Parse the transfer instruction using the appropriate library helper
    let parsedTransfer;
    try {
      if (programAddress === TOKEN_PROGRAM_ADDRESS.toString()) {
        parsedTransfer = parseTransferCheckedInstructionToken(transferIx as never);
      } else {
        parsedTransfer = parseTransferCheckedInstruction2022(transferIx as never);
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
        payer,
      };
    }

    // Verify that the facilitator's signers are not transferring their own funds
    const authorityAddress = parsedTransfer.accounts.authority.address.toString();
    if (signerAddresses.includes(authorityAddress)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
        payer,
      };
    }

    // Verify mint address matches requirements
    const mintAddress = parsedTransfer.accounts.mint.address.toString();
    if (mintAddress !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_mint_mismatch",
        payer,
      };
    }

    // Verify destination ATA matches expected ATA for payTo address
    const destATA = parsedTransfer.accounts.destination.address.toString();
    try {
      const [expectedDestATA] = await findAssociatedTokenPda({
        mint: requirements.asset as Address,
        owner: requirements.payTo as Address,
        tokenProgram:
          programAddress === TOKEN_PROGRAM_ADDRESS.toString()
            ? (TOKEN_PROGRAM_ADDRESS as Address)
            : (TOKEN_2022_PROGRAM_ADDRESS as Address),
      });

      if (destATA !== expectedDestATA.toString()) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_svm_payload_recipient_mismatch",
          payer,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_recipient_mismatch",
        payer,
      };
    }

    // Verify transfer amount meets requirements
    const amount = parsedTransfer.data.amount;
    if (amount < BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_amount_insufficient",
        payer,
      };
    }

    // Step 5: Sign and Simulate Transaction
    try {
      const feePayer = requirements.extra.feePayer as Address;

      // Sign transaction with the feePayer's signer
      const fullySignedTransaction = await this.signer.signTransaction(
        exactSvmPayload.transaction,
        feePayer,
        requirements.network,
      );

      // Simulate to verify transaction would succeed
      await this.signer.simulateTransaction(fullySignedTransaction, requirements.network);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: `transaction_simulation_failed: ${errorMessage}`,
        payer,
      };
    }

    return {
      isValid: true,
      invalidReason: undefined,
      payer,
    };
  }

  /**
   * Settles a payment by submitting the transaction.
   * Ensures the correct signer is used based on the feePayer specified in requirements.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const exactSvmPayload = payload.payload as ExactSvmPayloadV2;

    const valid = await this.verify(payload, requirements);
    if (!valid.isValid) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: valid.invalidReason ?? "verification_failed",
        payer: valid.payer || "",
      };
    }

    try {
      // Extract feePayer from requirements (already validated in verify)
      const feePayer = requirements.extra.feePayer as Address;

      // Sign transaction with the feePayer's signer
      const fullySignedTransaction = await this.signer.signTransaction(
        exactSvmPayload.transaction,
        feePayer,
        requirements.network,
      );

      // Send transaction to network
      const signature = await this.signer.sendTransaction(
        fullySignedTransaction,
        requirements.network,
      );

      // Wait for confirmation
      await this.signer.confirmTransaction(signature, requirements.network);

      return {
        success: true,
        transaction: signature,
        network: payload.accepted.network,
        payer: valid.payer,
      };
    } catch (error) {
      console.error("Failed to settle transaction:", error);
      return {
        success: false,
        errorReason: "transaction_failed",
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }
  }

  /**
   * Validates the instruction structure of the transaction.
   *
   * Required structure:
   * - Index 0: SetComputeUnitLimit instruction
   * - Index 1: SetComputeUnitPrice instruction
   * - Index 2: TransferChecked instruction (Token or Token-2022)
   * - Index 3+: Additional instructions (if allowAdditionalInstructions is true)
   *
   * @param instructions - The decompiled instructions from the transaction
   * @param signerAddresses - Addresses managed by the facilitator
   * @param feePayer - The fee payer address
   * @returns Validation result with transfer instruction index
   */
  private validateInstructions(
    instructions: readonly {
      programAddress: Address;
      accounts?: readonly { address: Address }[];
      data?: Readonly<Uint8Array>;
    }[],
    signerAddresses: string[],
    feePayer: string,
  ): InstructionValidationResult {
    const config = { ...DEFAULT_VERIFICATION_CONFIG, ...this.verificationConfig };

    // Minimum: ComputeLimit + ComputePrice + TransferChecked
    if (instructions.length < 3) {
      return {
        isValid: false,
        reason: "invalid_exact_svm_payload_transaction_instructions_length_too_few",
        transferInstructionIndex: 2,
      };
    }

    // Check maximum instruction count
    if (instructions.length > config.maxInstructionCount) {
      return {
        isValid: false,
        reason: `invalid_exact_svm_payload_transaction_instructions_length_exceeds_max_${config.maxInstructionCount}`,
        transferInstructionIndex: 2,
      };
    }

    // Verify fee payer is not in any instruction's accounts
    if (config.requireFeePayerNotInInstructions) {
      for (let i = 0; i < instructions.length; i++) {
        const ix = instructions[i];
        if (this.instructionIncludesAccount(ix, feePayer)) {
          return {
            isValid: false,
            reason: "invalid_exact_svm_payload_fee_payer_in_instruction_accounts",
            transferInstructionIndex: 2,
          };
        }
      }
    }

    // Verify required instructions at positions 0, 1, 2
    try {
      this.verifyComputeLimitInstruction(instructions[0] as never);
    } catch (error) {
      return {
        isValid: false,
        reason: error instanceof Error ? error.message : String(error),
        transferInstructionIndex: 2,
      };
    }

    try {
      this.verifyComputePriceInstruction(instructions[1] as never);
    } catch (error) {
      return {
        isValid: false,
        reason: error instanceof Error ? error.message : String(error),
        transferInstructionIndex: 2,
      };
    }

    // Verify instruction at index 2 is a token transfer
    const transferIx = instructions[2];
    const transferProgramId = transferIx.programAddress.toString();
    if (
      transferProgramId !== TOKEN_PROGRAM_ADDRESS.toString() &&
      transferProgramId !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      return {
        isValid: false,
        reason: "invalid_exact_svm_payload_no_transfer_instruction_at_index_2",
        transferInstructionIndex: 2,
      };
    }

    // Validate additional instructions (if any)
    if (instructions.length > 3) {
      if (!config.allowAdditionalInstructions) {
        return {
          isValid: false,
          reason: "invalid_exact_svm_payload_additional_instructions_not_allowed",
          transferInstructionIndex: 2,
        };
      }

      // Validate each additional instruction
      for (let i = 3; i < instructions.length; i++) {
        const ix = instructions[i];
        const programId = ix.programAddress.toString();

        // Check blocked list first (takes precedence)
        if (config.blockedProgramIds.includes(programId)) {
          return {
            isValid: false,
            reason: `invalid_exact_svm_payload_blocked_program_${programId}`,
            transferInstructionIndex: 2,
          };
        }

        // Check for custom verifier
        const customVerifier = config.customVerifiers.find(v =>
          v.programIds.includes(address(programId)),
        );
        if (customVerifier) {
          // Check position constraint if set
          if (customVerifier.allowedPositions && !customVerifier.allowedPositions.includes(i)) {
            return {
              isValid: false,
              reason: `invalid_exact_svm_payload_instruction_position_${programId}_at_${i}`,
              transferInstructionIndex: 2,
            };
          }

          // Run custom verification if provided
          if (customVerifier.verify) {
            try {
              const verifiableIx: VerifiableInstruction = {
                programAddress: ix.programAddress,
                accounts: ix.accounts as VerifiableInstruction["accounts"],
                data: ix.data,
              };
              const context: InstructionVerifierContext = {
                signerAddresses: signerAddresses.map(addr => address(addr)),
                feePayer: address(feePayer),
                instructionIndex: i,
              };
              customVerifier.verify(verifiableIx, context);
            } catch (error) {
              return {
                isValid: false,
                reason:
                  error instanceof Error ? error.message : `custom_verifier_failed_${programId}`,
                transferInstructionIndex: 2,
              };
            }
          }
          continue;
        }

        // Fall back to allowedProgramIds whitelist
        // If whitelist is set (non-empty), program must be in it
        // If whitelist is empty, allow any program (permissive mode)
        if (config.allowedProgramIds.length > 0 && !config.allowedProgramIds.includes(programId)) {
          return {
            isValid: false,
            reason: `invalid_exact_svm_payload_program_not_allowed_${programId}`,
            transferInstructionIndex: 2,
          };
        }
      }
    }

    return {
      isValid: true,
      transferInstructionIndex: 2,
    };
  }

  /**
   * Checks if an instruction includes a specific account address.
   *
   * @param instruction - The instruction to check
   * @param instruction.accounts - The accounts list from the instruction
   * @param accountAddress - The account address to look for
   * @returns true if the account is found in the instruction's accounts
   */
  private instructionIncludesAccount(
    instruction: { accounts?: readonly { address: Address }[] },
    accountAddress: string,
  ): boolean {
    if (!instruction.accounts) {
      return false;
    }
    return instruction.accounts.some(acc => acc.address.toString() === accountAddress);
  }

  /**
   * Verify that the compute limit instruction is valid.
   *
   * @param instruction - The compute limit instruction
   * @param instruction.programAddress - Program address
   * @param instruction.data - Instruction data bytes
   */
  private verifyComputeLimitInstruction(instruction: {
    programAddress: Address;
    data?: Readonly<Uint8Array>;
  }): void {
    const programAddress = instruction.programAddress.toString();

    if (
      programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() ||
      !instruction.data ||
      instruction.data[0] !== 2 // discriminator for SetComputeUnitLimit
    ) {
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    }

    try {
      parseSetComputeUnitLimitInstruction(instruction as never);
    } catch {
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    }
  }

  /**
   * Verify that the compute price instruction is valid.
   *
   * @param instruction - The compute price instruction
   * @param instruction.programAddress - Program address
   * @param instruction.data - Instruction data bytes
   */
  private verifyComputePriceInstruction(instruction: {
    programAddress: Address;
    data?: Readonly<Uint8Array>;
  }): void {
    const programAddress = instruction.programAddress.toString();

    if (
      programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() ||
      !instruction.data ||
      instruction.data[0] !== 3 // discriminator for SetComputeUnitPrice
    ) {
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    }

    try {
      const parsedInstruction = parseSetComputeUnitPriceInstruction(instruction as never);

      // Check if price exceeds maximum (5 lamports per compute unit)
      if (
        (parsedInstruction as unknown as { microLamports: bigint }).microLamports >
        BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)
      ) {
        throw new Error(
          "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("too_high")) {
        throw error;
      }
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    }
  }
}
