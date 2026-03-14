/**
 * Wallet tools — on-chain balance queries, token transfers, and x402 micropayments.
 *
 * Pure capability tools: the agent decides when and how to use them.
 * On-chain state is queried directly (not duplicated into VEIL facets).
 */

import type { ToolHandler } from '@connectome/agent-core';
import type { WalletChainConfig } from '../bot-config.js';

// ---------------------------------------------------------------------------
// Context — initialized once at startup, shared across tool invocations
// ---------------------------------------------------------------------------

export interface WalletToolContext {
  evmAccount?: import('viem/accounts').PrivateKeyAccount;
  evmClients?: Map<string, import('viem').PublicClient>;
  solanaKeypair?: import('@solana/web3.js').Keypair;
  solanaConnections?: Map<string, import('@solana/web3.js').Connection>;
  chains: WalletChainConfig[];
  streamId?: string;
}

// ---------------------------------------------------------------------------
// Well-known USDC contract addresses per EVM chain ID
// ---------------------------------------------------------------------------

const EVM_USDC_ADDRESSES: Record<number, `0x${string}`> = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',      // Ethereum mainnet
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',    // Base
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',     // Polygon
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',      // Optimism
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',   // Arbitrum One
};

// Solana USDC mint
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Minimal ERC-20 ABI for balanceOf and transfer
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// Block explorer base URLs by chain ID
const EXPLORER_TX_URLS: Record<number, string> = {
  1: 'https://etherscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  137: 'https://polygonscan.com/tx/',
  10: 'https://optimistic.etherscan.io/tx/',
  42161: 'https://arbiscan.io/tx/',
};

// ---------------------------------------------------------------------------
// Tool 1: get_wallet_info
// ---------------------------------------------------------------------------

export function createGetWalletInfoTool(ctx: WalletToolContext): ToolHandler {
  return {
    name: 'get_wallet_info',
    description:
      'Get your wallet addresses and configured blockchain networks. ' +
      'Call this first to discover what wallets and chains are available.',
    parameters: {},
    handler: async (): Promise<string> => {
      const lines: string[] = [];

      if (ctx.evmAccount) {
        lines.push(`EVM address: ${ctx.evmAccount.address}`);
      }
      if (ctx.solanaKeypair) {
        lines.push(`Solana address: ${ctx.solanaKeypair.publicKey.toBase58()}`);
      }

      if (lines.length === 0) {
        return 'No wallets configured.';
      }

      if (ctx.chains.length > 0) {
        lines.push('');
        lines.push(`Configured chains (${ctx.chains.length}):`);
        for (const chain of ctx.chains) {
          const chainIdStr = chain.chain_id ? `, chain_id: ${chain.chain_id}` : '';
          lines.push(`  • ${chain.network} (type: ${chain.chain}${chainIdStr}) — use chain="${chain.network}" in other wallet tools`);
        }
      }

      return lines.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: check_balance
// ---------------------------------------------------------------------------

export function createCheckBalanceTool(ctx: WalletToolContext): ToolHandler {
  return {
    name: 'check_balance',
    description:
      'Check wallet balances (native token + USDC) on configured chains. ' +
      'Optionally filter to a specific chain network name.',
    parameters: {
      chain: {
        type: 'string',
        description: 'Network name to check (e.g. "base", "solana-mainnet"). Omit for all chains.',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const filterChain = input.chain as string | undefined;
      const results: string[] = [];

      // EVM chains
      if (ctx.evmAccount && ctx.evmClients) {
        for (const [network, client] of ctx.evmClients) {
          if (filterChain && network !== filterChain) continue;

          try {
            const chainConfig = ctx.chains.find(c => c.network === network);
            const balance = await client.getBalance({ address: ctx.evmAccount.address });
            const ethBalance = Number(balance) / 1e18;
            results.push(`${network}: ${ethBalance.toFixed(6)} ETH`);

            // USDC balance
            const chainId = chainConfig?.chain_id;
            const usdcAddr = chainId ? EVM_USDC_ADDRESSES[chainId] : undefined;
            if (usdcAddr) {
              try {
                const usdcBalance = await client.readContract({
                  address: usdcAddr,
                  abi: ERC20_ABI,
                  functionName: 'balanceOf',
                  args: [ctx.evmAccount.address],
                });
                const usdcHuman = Number(usdcBalance) / 1e6;
                results.push(`${network}: ${usdcHuman.toFixed(2)} USDC`);
              } catch {
                // USDC contract not available on this network
              }
            }
          } catch (err: any) {
            results.push(`${network}: Error — ${err.message}`);
          }
        }
      }

      // Solana chains
      if (ctx.solanaKeypair && ctx.solanaConnections) {
        const { PublicKey } = await import('@solana/web3.js');

        for (const [network, connection] of ctx.solanaConnections) {
          if (filterChain && network !== filterChain) continue;

          try {
            const balance = await connection.getBalance(ctx.solanaKeypair.publicKey);
            const solBalance = balance / 1e9;
            results.push(`${network}: ${solBalance.toFixed(6)} SOL`);

            // USDC SPL token balance
            try {
              const usdcMint = new PublicKey(SOLANA_USDC_MINT);
              const tokenAccounts = await connection.getTokenAccountsByOwner(
                ctx.solanaKeypair.publicKey,
                { mint: usdcMint },
              );
              if (tokenAccounts.value.length > 0) {
                // Parse token account data (SPL Token layout: amount at offset 64, 8 bytes LE)
                const data = tokenAccounts.value[0].account.data;
                const buf = Buffer.from(data);
                const amount = buf.readBigUInt64LE(64);
                const usdcHuman = Number(amount) / 1e6;
                results.push(`${network}: ${usdcHuman.toFixed(2)} USDC`);
              } else {
                results.push(`${network}: 0.00 USDC`);
              }
            } catch {
              // USDC token account lookup failed
            }
          } catch (err: any) {
            results.push(`${network}: Error — ${err.message}`);
          }
        }
      }

      if (results.length === 0) {
        return filterChain
          ? `No wallet configured for chain "${filterChain}".`
          : 'No wallets configured.';
      }

      return results.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 3: transfer
// ---------------------------------------------------------------------------

export function createTransferTool(ctx: WalletToolContext): ToolHandler {
  return {
    name: 'transfer',
    description:
      'Transfer tokens to an address. Supports native tokens (ETH/SOL) and USDC. ' +
      'Always check_balance first to verify sufficient funds.',
    parameters: {
      to: {
        type: 'string',
        description: 'Recipient address',
      },
      amount: {
        type: 'string',
        description: 'Amount to send in human-readable units (e.g. "0.01", "5.50")',
      },
      token: {
        type: 'string',
        description: 'Token to transfer: "native" (default) or "USDC"',
      },
      chain: {
        type: 'string',
        description: 'Network name (e.g. "base", "solana-mainnet")',
      },
    },
    required: ['to', 'amount', 'chain'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const { to, amount, chain } = input;
      const token = (input.token || 'native').toUpperCase();

      if (!to) return 'Error: recipient address (to) is required';
      if (!amount) return 'Error: amount is required';
      if (!chain) return 'Error: chain network name is required';

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) return 'Error: amount must be a positive number';

      const chainConfig = ctx.chains.find(c => c.network === chain);
      if (!chainConfig) return `Error: chain "${chain}" not configured`;

      // EVM transfer
      if (chainConfig.chain === 'evm') {
        if (!ctx.evmAccount) return 'Error: no EVM wallet configured';
        const client = ctx.evmClients?.get(chain);
        if (!client) return `Error: no client for chain "${chain}"`;

        try {
          const { createWalletClient, http, parseEther, parseUnits } = await import('viem');

          const walletClient = createWalletClient({
            account: ctx.evmAccount,
            transport: http(chainConfig.rpc_url),
          });

          let hash: string;

          if (token === 'NATIVE' || token === 'ETH') {
            hash = await walletClient.sendTransaction({
              chain: null,
              to: to as `0x${string}`,
              value: parseEther(amount),
            });
          } else if (token === 'USDC') {
            const usdcAddr = chainConfig.chain_id ? EVM_USDC_ADDRESSES[chainConfig.chain_id] : undefined;
            if (!usdcAddr) return `Error: USDC address not known for chain_id ${chainConfig.chain_id}`;

            const usdcAmount = parseUnits(amount, 6);
            hash = await walletClient.writeContract({
              chain: null,
              address: usdcAddr,
              abi: ERC20_ABI,
              functionName: 'transfer',
              args: [to as `0x${string}`, usdcAmount],
            });
          } else {
            return `Error: unsupported token "${token}". Use "native" or "USDC".`;
          }

          const explorerBase = chainConfig.chain_id ? EXPLORER_TX_URLS[chainConfig.chain_id] : undefined;
          const explorerLink = explorerBase ? `\n${explorerBase}${hash}` : '';

          return `Transfer sent!\nTx: ${hash}${explorerLink}`;
        } catch (err: any) {
          return `Transfer failed: ${err.message}`;
        }
      }

      // Solana transfer
      if (chainConfig.chain === 'solana') {
        if (!ctx.solanaKeypair) return 'Error: no Solana wallet configured';
        const connection = ctx.solanaConnections?.get(chain);
        if (!connection) return `Error: no connection for chain "${chain}"`;

        try {
          const {
            PublicKey, Transaction, SystemProgram,
          } = await import('@solana/web3.js');

          const toPubkey = new PublicKey(to);
          let tx: InstanceType<typeof Transaction>;

          if (token === 'NATIVE' || token === 'SOL') {
            const lamports = Math.round(amountNum * 1e9);
            tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: ctx.solanaKeypair.publicKey,
                toPubkey,
                lamports,
              }),
            );
          } else if (token === 'USDC') {
            // SPL USDC transfer using raw token program instruction
            // Uses @solana/web3.js TransactionInstruction directly (no @solana/spl-token dep)
            const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
            const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
            const usdcMint = new PublicKey(SOLANA_USDC_MINT);

            // Derive associated token addresses
            const [fromAta] = PublicKey.findProgramAddressSync(
              [ctx.solanaKeypair.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
              ASSOCIATED_TOKEN_PROGRAM_ID,
            );
            const [toAta] = PublicKey.findProgramAddressSync(
              [toPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
              ASSOCIATED_TOKEN_PROGRAM_ID,
            );

            // SPL Token transfer instruction (instruction index 3)
            const usdcAmount = BigInt(Math.round(amountNum * 1e6));
            const dataBuffer = Buffer.alloc(9);
            dataBuffer.writeUInt8(3, 0); // Transfer instruction
            dataBuffer.writeBigUInt64LE(usdcAmount, 1);

            const { TransactionInstruction } = await import('@solana/web3.js');
            const transferIx = new TransactionInstruction({
              keys: [
                { pubkey: fromAta, isSigner: false, isWritable: true },
                { pubkey: toAta, isSigner: false, isWritable: true },
                { pubkey: ctx.solanaKeypair.publicKey, isSigner: true, isWritable: false },
              ],
              programId: TOKEN_PROGRAM_ID,
              data: dataBuffer,
            });

            tx = new Transaction().add(transferIx);
          } else {
            return `Error: unsupported token "${token}". Use "native" or "USDC".`;
          }

          // Send and confirm via HTTP polling (avoids WebSocket signatureSubscribe
          // which fails on many RPC providers including Alchemy)
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          tx.recentBlockhash = blockhash;
          tx.feePayer = ctx.solanaKeypair.publicKey;

          const signature = await connection.sendTransaction(tx, [ctx.solanaKeypair], {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });

          // Poll getSignatureStatuses for confirmation (pure HTTP, no WebSocket)
          const tokenLabel = (token === 'NATIVE' || token === 'SOL') ? 'SOL' : token;
          const start = Date.now();
          while (Date.now() - start < 60_000) {
            const { value } = await connection.getSignatureStatuses([signature]);
            const status = value[0];
            if (status) {
              if (status.err) {
                return `${tokenLabel} transfer failed on-chain: ${JSON.stringify(status.err)}\nTx: ${signature}\nhttps://solscan.io/tx/${signature}`;
              }
              if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return `${tokenLabel} transfer confirmed!\nTx: ${signature}\nhttps://solscan.io/tx/${signature}`;
              }
            }
            // Also check if blockhash expired (tx will never land)
            const currentHeight = await connection.getBlockHeight('confirmed');
            if (currentHeight > lastValidBlockHeight) {
              return `${tokenLabel} transfer sent but blockhash expired before confirmation.\nTx: ${signature}\nhttps://solscan.io/tx/${signature}`;
            }
            await new Promise(r => setTimeout(r, 2000));
          }

          return `${tokenLabel} transfer sent (confirmation pending).\nTx: ${signature}\nhttps://solscan.io/tx/${signature}`;
        } catch (err: any) {
          return `Transfer failed: ${err.message}`;
        }
      }

      return `Error: unsupported chain type "${chainConfig.chain}"`;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 4: x402_fetch
// ---------------------------------------------------------------------------

export function createX402FetchTool(ctx: WalletToolContext): ToolHandler {
  return {
    name: 'x402_fetch',
    description:
      'Fetch a URL that may require x402 micropayment. If the server responds with HTTP 402, ' +
      'the payment is automatically signed and the request retried. Use for paid APIs and content. ' +
      'Supports EVM chains (Base, Ethereum, Polygon) via the x402 protocol.',
    parameters: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      method: {
        type: 'string',
        description: 'HTTP method (default: "GET")',
      },
      headers: {
        type: 'object',
        description: 'Additional HTTP headers as key-value pairs',
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT)',
      },
      max_payment_usd: {
        type: 'number',
        description: 'Maximum payment in USD (default: 1.00). Rejects requests above this.',
      },
    },
    required: ['url'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const { url, method = 'GET', headers = {}, body } = input;
      const maxPaymentUsd = input.max_payment_usd ?? 1.0;

      if (!url) return 'Error: url is required';
      if (!ctx.evmAccount) return 'Error: x402 requires an EVM wallet. No EVM wallet configured.';

      try {
        // Step 1: Make initial request
        const fetchOpts: RequestInit = {
          method,
          headers: { ...headers },
          signal: AbortSignal.timeout(30000),
        };
        if (body && method !== 'GET') {
          fetchOpts.body = body;
        }

        const initialResponse = await fetch(url, fetchOpts);

        // Not a 402 — return response directly
        if (initialResponse.status !== 402) {
          const text = await initialResponse.text();
          if (!initialResponse.ok) {
            return `HTTP ${initialResponse.status}: ${text.substring(0, 2000)}`;
          }
          return text.substring(0, 50000);
        }

        // Step 2: Build x402 client and handle payment
        const { x402Client, x402HTTPClient } = await import('@x402/core/client');
        const { toClientEvmSigner } = await import('@x402/evm');
        const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
        const { createPublicClient, http } = await import('viem');

        // Find an EVM chain for the signer
        const evmChain = ctx.chains.find(c => c.chain === 'evm');
        if (!evmChain) return 'Error: no EVM chain configured for x402 payment signing';

        // Create signer from account + public client
        const publicClient = ctx.evmClients?.get(evmChain.network);
        const signer = toClientEvmSigner(
          ctx.evmAccount,
          publicClient || createPublicClient({ transport: http(evmChain.rpc_url) }),
        );

        // Build x402 client with EVM scheme
        const client = new x402Client();
        registerExactEvmScheme(client, { signer });
        const httpClient = new x402HTTPClient(client);

        // Step 3: Parse 402 response
        const paymentRequired = httpClient.getPaymentRequiredResponse(
          (name: string) => initialResponse.headers.get(name),
          await initialResponse.clone().json().catch(() => undefined),
        );

        // Step 4: Check payment amount against guard
        // Payment amounts in x402 are in token smallest units (USDC = 6 decimals)
        const maxAmount = (paymentRequired as any).maxAmountRequired ??
          (paymentRequired as any).paymentRequirements?.[0]?.maxAmountRequired ?? '0';
        const paymentUsd = Number(maxAmount) / 1e6;
        if (paymentUsd > maxPaymentUsd) {
          return `Payment rejected: $${paymentUsd.toFixed(4)} exceeds max_payment_usd ($${maxPaymentUsd.toFixed(2)})`;
        }

        // Step 5: Create payment payload and encode as headers
        const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

        // Step 6: Retry request with payment headers
        const paidResponse = await fetch(url, {
          method,
          headers: { ...headers, ...paymentHeaders },
          body: body && method !== 'GET' ? body : undefined,
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await paidResponse.text();

        if (!paidResponse.ok) {
          return `Payment sent but request failed: HTTP ${paidResponse.status}: ${responseText.substring(0, 2000)}`;
        }

        return `[x402 payment: ~$${paymentUsd.toFixed(4)}]\n${responseText.substring(0, 50000)}`;
      } catch (err: any) {
        return `x402 fetch failed: ${err.message}`;
      }
    },
  };
}
