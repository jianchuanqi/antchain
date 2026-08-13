import { ApiResponse } from 'src/deps.ts';
import { 
  defaultHeaders, 
  generateUUID
} from '../base.ts';
import { BlockchainConfig, defaultConfig, blockChainEndpoint } from 'src/config/blockchain.ts';
import { BlockchainAuth } from '../auth/index.ts';
import { DataDepositParams, DataQueryParams } from './types.ts';

/**
 * Class for handling blockchain data operations
 */
export class BlockchainData {
  private config: BlockchainConfig;
  private auth: BlockchainAuth;

  /**
   * Create a new BlockchainData instance
   * @param config Configuration options (optional)
   */
  constructor(config?: Partial<BlockchainConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.auth = new BlockchainAuth(config);
  }

  /**
   * Process API response
   * @param response Fetch response
   * @param successMessage Default success message
   * @returns Processed API response
   */
  private async processResponse(response: Response, successMessage: string): Promise<ApiResponse> {
    if (response.ok) {
      const responseText = await response.text();
      try {
        const data = JSON.parse(responseText);
        console.log('data', data);
        return {
          success: data.success ?? true,
          data: data.data,
          message: data.message || successMessage,
          code: data.code || 'SUCCESS'
        };
      } catch (parseError) {
        console.error('Error parsing response:', parseError);
        return {
          success: false,
          message: 'Failed to parse response',
          code: 'PARSE_ERROR',
          rawResponse: responseText
        };
      }
    } else {
      return {
        success: false,
        message: `HTTP Error: ${response.status} ${response.statusText}`,
        code: 'HTTP_ERROR'
      };
    }
  }

  /**
   * Deposit data to the blockchain
   * @param params Data deposit parameters
   * @param token Authentication token (optional)
   * @returns Response containing the data ID
   */
  async depositData(
    params: DataDepositParams,
    token?: string
  ): Promise<ApiResponse> {
    try {
      // Get token if not provided
      if (!token) {
        const authToken = await this.auth.getToken();
        console.log('authToken', authToken);
        if (!authToken) {
          return {
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
          };
        }
        token = authToken;
      }

      // Use the chainCallForBiz endpoint for data deposit
      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCallForBiz}`;
      
      // 参考datapush.js中的格式构建请求体
      const requestBody = {
        'accessId': this.config.accessId,
        'account': params.account || this.config.account,
        'bizid': params.bizId || this.config.bizId,
        'content': params.data ? JSON.stringify(params.data) : '',
        'gas': 0,
        'method': 'DEPOSIT',
        'mykmsKeyId': this.config.kmsKeyId,
        'orderId': params.txId || generateUUID(),
        'tenantid': this.config.tenantId,
        'token': token,
        'withGasHold': false,
        // 保留原有额外参数
        'timestamp': params.timestamp || new Date().toISOString(),
        'metadata': params.metadata ? JSON.stringify(params.metadata) : undefined,
        'hash': params.hash
      };
      
      // Prepare headers
      const headers = {
        ...defaultHeaders
        // 移除Authorization头部，token现在在请求体中
      };
      
      console.log('Sending deposit request with params:', JSON.stringify(requestBody, null, 2));
      
      // Send request
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });

      console.log('response', JSON.stringify(response, null, 2));
      console.log('response', response);
      
      // 处理响应并提取交易哈希
      const result = await this.processResponse(response, 'Data deposit successful');
      
      // 记录请求的orderId以便于调试和后期查询
      if (result.success) {
        console.log(`Transaction orderId: ${requestBody.orderId}`);
        // 将orderId作为dataId返回，方便后续查询
        if (typeof result.data === 'string') {
          // 如果返回的是字符串，可能是交易哈希，直接将其用作hash
          console.log(`Transaction hash: ${result.data}`);
        } else if (!result.data) {
          // 如果没有返回数据，使用orderId作为可查询的ID
          result.data = requestBody.orderId;
        }
      }
      console.log('result', result);
      
      return result;
    } catch (error) {
      console.error('Error depositing data:', error);
      return {
        success: false,
        message: `Failed to deposit data: ${error instanceof Error ? error.message : String(error)}`,
        code: 'REQUEST_ERROR'
      };
    }
  }

  /**
   * Query data from the blockchain
   * @param params Data query parameters
   * @param token Authentication token (optional)
   * @returns Response containing the queried data
   */
  async queryData(
    params: DataQueryParams,
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

      // Use the chainCall endpoint for data query
      const url = `${this.config.restUrl}${blockChainEndpoint.contract.chainCall}`;
      
      // 基于dataread.js中的实现构建查询参数
      let requestBody;
      
      if (params.dataId) {
        // 使用dataId作为hash参数进行查询
        requestBody = {
          'accessId': this.config.accessId,
          'bizid': params.bizId || this.config.bizId,
          'method': 'QUERYTRANSACTION',
          'token': token,
          'hash': params.dataId  // 使用dataId作为hash参数
        };
      } else if (params.hash) {
        // 如果有hash，使用相同的方法
        requestBody = {
          'accessId': this.config.accessId,
          'bizid': params.bizId || this.config.bizId,
          'method': 'QUERYTRANSACTION',
          'token': token,
          'hash': params.hash
        };
      } else {
        // 时间范围查询
        requestBody = {
          'accessId': this.config.accessId,
          'bizid': params.bizId || this.config.bizId,
          'method': 'QUERYTRANSACTIONBIZ',
          'token': token,
          'startTime': params.startTime,
          'endTime': params.endTime,
          'limit': params.limit || 10,
          'page': params.page || 1
        };
      }
      
      // Prepare headers
      const headers = {
        ...defaultHeaders
      };
      
      console.log('Sending query request with params:', JSON.stringify(requestBody, null, 2));
      
      // Send request
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });
      
      return await this.processResponse(response, 'Data query successful');
    } catch (error) {
      console.error('Error querying data:', error);
      return {
        success: false,
        message: `Failed to query data: ${error instanceof Error ? error.message : String(error)}`,
        code: 'REQUEST_ERROR'
      };
    }
  }
  async queryReceipt(dataId: string,token?: string): Promise<ApiResponse> {
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
    const requestBody = {
      'accessId': this.config.accessId,
      'bizid': this.config.bizId,
      'method': 'QUERYRECEIPT',
      'token': token,
      'hash': dataId
    }
    const headers = {
      ...defaultHeaders
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });
    return await this.processResponse(response, 'Query receipt successful');
  }
} 


export function base64ToUint8Array(base64Str: string): Uint8Array {
  const binary = atob(base64Str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
} 

export function parseData(data: string) {
    try {
      // 解析JSON字符串（如果结果是字符串形式）
      const resultObj = typeof data === 'string' 
        ? JSON.parse(data) 
        : data;
      
      // 获取base64编码的数据
      const base64Data = resultObj.transactionDO?.data;
      
      if (base64Data) {
        // 解码base64数据
        // 在Deno中使用:
        const decodedText = new TextDecoder().decode(
          base64ToUint8Array(base64Data)
        );
        
        // 解析为JSON对象
        const originalData = JSON.parse(decodedText);
        console.log('Original stored data:', originalData);
        return originalData;
      }
    } catch (error) {
      console.error('Error decoding data:', error);
      return null;
    }
  }
