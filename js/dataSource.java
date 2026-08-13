package com.antgroup.antchain.fastdf.dataproxy.manager.connector.api

import com.alibaba.fastjson.JSONArray
import com.alibaba.fastjson.JSONObject
import com.antgroup.antchain.idata.rest.component.common.data.AbstractRestApiDataFetchAdaptor
import com.antgroup.antchain.idata.rest.component.common.model.FetchDataResultBO
import com.antgroup.antchain.idata.rest.component.common.model.RestApiDataSourceConfigBO
import com.antgroup.antchain.fastdf.dataproxy.manager.connector.api.relateObject.DatasetMetaTableSchemaFieldTypeEnum
import com.antgroup.antchain.fastdf.dataproxy.manager.connector.api.relateObject.ApiDatasetResponse
import com.antgroup.antchain.fastdf.dataproxy.manager.connector.api.relateObject.DatasetTableSchemaFieldData
import lombok.AllArgsConstructor
import lombok.Builder
import lombok.Data
import lombok.NoArgsConstructor
import okhttp3.*
import org.apache.commons.lang3.ObjectUtils

import javax.validation.constraints.NotBlank

/**
 * API数据源模板, DatasetDemo为class名称
 */
class DatasetDemo extends AbstractRestApiDataFetchAdaptor<DatasetRequest, ApiDatasetResponse> {

    DatasetDemo(OkHttpClient client, RestApiDataSourceConfigBO config) {
        super(client, config)
    }

    @Override
    Request.Builder createNewCall(DatasetRequest validatedCondition, String token) throws Exception {
        String url = requireEnvironment('ANTCHAIN_LEGACY_EMBEDDING_API_URL')
        String authorization = requireBearerAuthorization(token)
        String apiKey = requireEnvironment('ANTCHAIN_LEGACY_API_X_KEY')

        JSONObject requestBody = new JSONObject()
        if (!ObjectUtils.isEmpty(validatedCondition) && !ObjectUtils.isEmpty(validatedCondition.getQuery())) {
            requestBody.put('query', validatedCondition.getQuery())
        }

        RequestBody body = RequestBody.create(MediaType.parse('application/json'),
                requestBody.toJSONString())

        return new Request.Builder()
                .url(url)
                .post(body)
                .addHeader('Authorization', authorization)
                .addHeader('Content-Type', 'application/json')
                .addHeader('x_key', apiKey)
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name)
        if (ObjectUtils.isEmpty(value) || value.trim().isEmpty()) {
            throw new IllegalStateException('Missing required environment variable: ' + name)
        }
        return value.trim()
    }

    private static String requireBearerAuthorization(String token) {
        if (ObjectUtils.isEmpty(token) || token.trim().isEmpty()) {
            throw new IllegalStateException('Missing required connector token')
        }
        String normalized = token.trim()
        return normalized.startsWith('Bearer ') ? normalized : 'Bearer ' + normalized
    }

    @Override
    protected FetchDataResultBO<ApiDatasetResponse> parseHttpResponse(DatasetRequest apiDatasetRequest, String body) {
        JSONObject res = JSONObject.parseObject(body)
        JSONArray data = res.getJSONArray('embedding')
        ApiDatasetResponse response = new ApiDatasetResponse()
        List<List<DatasetTableSchemaFieldData>> dataList = new ArrayList<>()

        List<DatasetTableSchemaFieldData> datasetTableSchemaFieldDataList = new ArrayList<>()
        for (int i = 0; i < data.size(); i++) {
            DatasetTableSchemaFieldData datasetTableSchemaFieldData = new DatasetTableSchemaFieldData()
            datasetTableSchemaFieldData.setFieldName('dimension_' + i)
            datasetTableSchemaFieldData.setFieldType(DatasetMetaTableSchemaFieldTypeEnum.DOUBLE)
            datasetTableSchemaFieldData.setCurrentType(DatasetMetaTableSchemaFieldTypeEnum.DOUBLE)
            datasetTableSchemaFieldData.setCurrentValue(data.get(i))
            datasetTableSchemaFieldDataList.add(datasetTableSchemaFieldData)
        }
        dataList.add(datasetTableSchemaFieldDataList)

        response.setDataList(dataList)
        response.setJsonResult(body)
        return FetchDataResultBO.success(response)
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    static class DatasetRequest {
        @NotBlank
        public String query

        String getQuery() {
            return query
        }

        void setQuery(String query) {
            this.query = query
        }
    }
}
