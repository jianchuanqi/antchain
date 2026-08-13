import { ApiResponse } from 'src/deps.ts';
import { 
  defaultHeaders, 
  generateUUID, 
  sendRequest, 
  parseResponse
} from '../base.ts';
import { BlockchainConfig, defaultConfig,blockChainEndpoint } from 'src/config/blockchain.ts';
import { BlockchainAuth } from '../auth/index.ts';
import { ContractMethodParams, ContractDeployParams } from './types.ts';

/**
 * Class for handling blockchain contract operations
 */
export class BlockchainContract {
  private config: BlockchainConfig;
  private auth: BlockchainAuth;

  /**
   * Create a new BlockchainContract instance
   * @param config Configuration options (optional)
   */
  constructor(config?: Partial<BlockchainConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.auth = new BlockchainAuth(config);
  }

  /**
   * Call a contract method
   * @param params Contract method parameters
   * @param token Authentication token (optional)
   * @returns Response containing the call result
   */
  async callMethod(
    params: ContractMethodParams,
    token?: string
  ): Promise<ApiResponse> {
    try {
      // Get token if not provided
      if (!token) {
        const authToken = await this.auth.getToken();
        if (!authToken) {
          return {
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
          };
        }
        token = authToken;
      }

      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCallForBiz}`;

      const requestBody: Record<string, unknown> = {
        accessId: this.config.accessId,
        bizid: this.config.bizId,
        account: this.config.account,
        contractName: params.contractName,
        methodSignature: params.methodSignature,
        isLocalTransaction: params.isLocalTransaction,
        method: 'CALLWASMCONTRACTASYNC',
        token,
        orderId: params.orderId || generateUUID(),
        timestamp: new Date().toISOString(),
        mykmsKeyId: this.config.kmsKeyId,
        inputParamListStr: params.inputParamListStr,
        outTypes: params.outputTypes,
        tenantid: this.config.tenantId,
        gas: 0,
        withGasHold: false,
      };

      // 去除undefined字段
      Object.keys(requestBody).forEach(key => requestBody[key] === undefined && delete requestBody[key]);

      // Prepare headers
      const headers = {
        ...defaultHeaders
        // 不需要Authorization头，token已在body
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });

      return await parseResponse(response);
    } catch (error) {
      console.error('Error calling contract method:', error);
      return {
        success: false,
        message: 'Failed to call contract method',
        code: 'REQUEST_ERROR'
      };
    }
  }

  /**
   * Deploy a new contract
   * @param params Contract deployment parameters
   * @param token Authentication token (optional)
   * @returns Response containing the deployment result
   */
  async deployContract(
    params: ContractDeployParams,
    token?: string
  ): Promise<ApiResponse> {
    try {
      // Get token if not provided
      if (!token) {
        const authToken = await this.auth.getToken();
        if (!authToken) {
          return {
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
          };
        }
        token = authToken;
      }

      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCallForBiz}`;
      
      // Prepare request body
      const requestBody = {
        ...params,
        txId: generateUUID(), // Generate transaction ID
        timestamp: new Date().toISOString()
      };
      
      // Prepare headers
      const headers = {
        ...defaultHeaders,
        'Authorization': `Bearer ${token}`
      };
      
      // Send request
      const response = await sendRequest(
        url,
        'POST',
        headers,
        requestBody
      );
      
      return await parseResponse(response);
    } catch (error) {
      console.error('Error deploying contract:', error);
      return {
        success: false,
        message: 'Failed to deploy contract',
        code: 'REQUEST_ERROR'
      };
    }
  }

  /**
   * Call a WASM contract method (e.g., GetName)
   * @param token Authentication token
   * @returns Response containing the call result
   */
  async callWasmContract(token?: string,methodSignature:string='GetName()'): Promise<ApiResponse> {
    try {
      if (!token) {
        const authToken = await this.auth.getToken();
        if (!authToken) {
          return {
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
          };
        }
        token = authToken;
      }
      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCallForBiz}`;
      const orderId = generateUUID();
      console.log('orderId:', orderId);
      const requestBody = {
        orderId: orderId,
        bizid: this.config.bizId,
        account: this.config.account,
        contractName: this.config.contractName,
        methodSignature: methodSignature,
        mykmsKeyId: this.config.kmsKeyId,
        method: 'CALLWASMCONTRACTASYNC',
        inputParamListStr: '[]',
        outTypes: '[string]',
        tenantid: this.config.tenantId,
        gas: 0,
        withGasHold: false,
        token: token,
        accessId: this.config.accessId,
      };
      const headers = {
        ...defaultHeaders
      };
      const response = await sendRequest(
        url,
        'POST',
        headers,
        requestBody
      );
      return await parseResponse(response);
    } catch (error) {
      console.error('Error calling WASM contract:', error);
      return {
        success: false,
        message: 'Failed to call WASM contract',
        code: 'REQUEST_ERROR'
      };
    }
  }

  /**
   * Set WASM contract name (setName)
   * @param token Authentication token
   * @param newName New name to set
   * @returns Response containing the set result
   */
  async setContractName(token: string, newName: string): Promise<ApiResponse> {
    try {
      if (!token) {
        const authToken = await this.auth.getToken();
        if (!authToken) {
          return {
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
          };
        }
        token = authToken;
      }
      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCallForBiz}`;
      const orderId = generateUUID();
      const requestBody = {
        accessId: this.config.accessId,
        account: this.config.account,
        bizid: this.config.bizId,
        gas: 0,
        inputParamListStr: JSON.stringify([newName]),
        method: 'CALLWASMCONTRACTASYNC',
        methodSignature: 'setName(string)',
        isLocalTransaction: true,
        mykmsKeyId: this.config.kmsKeyId,
        orderId: orderId,
        outTypes: '[]',
        tenantid: this.config.tenantId,
        token,
        withGasHold: false,
        contractName: this.config.contractName
      };
      const headers = {
        ...defaultHeaders
      };
      const response = await sendRequest(
        url,
        'POST',
        headers,
        requestBody
      );
      return await parseResponse(response);
    } catch (error) {
      console.error('Error setting contract name:', error);
      return {
        success: false,
        message: 'Failed to set contract name',
        code: 'REQUEST_ERROR'
      };
    }
  }
}
