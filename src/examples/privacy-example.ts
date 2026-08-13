import { BlockchainAuth } from "../core/blockchain/auth/index.ts";
import { BlockchainPrivacy } from "../core/blockchain/privacy/index.ts";
import { PrivacyComputeType } from "../core/blockchain/types.ts";
import { defaultConfig } from "../deps.ts";

/**
 * 隐私计算示例
 */
async function main() {
  try {
    console.log("=== 隐私计算示例 ===");
    console.log(`应用名称: ${defaultConfig.app.name}`);
    console.log(`版本: ${defaultConfig.app.version}`);
    console.log(`环境: ${defaultConfig.app.environment}`);

    // 初始化认证和隐私计算模块 - 使用统一配置
    const auth = new BlockchainAuth(defaultConfig.blockchain);
    const privacy = new BlockchainPrivacy();

    // 1. 获取认证令牌
    console.log("\n【1】获取认证令牌");
    const token = await auth.getToken();
    if (!token) {
      throw new Error("获取令牌失败，请检查访问凭证");
    }
    console.log("令牌获取成功！");

    // 2. 创建隐私计算任务
    console.log("\n【2】创建隐私计算任务");

    // 任务输入数据 - 这里是一个简单的求平均值函数
    const inputData = {
      function:
        "function calculateAverage(data) { return data.reduce((a,b) => a+b, 0) / data.length; }",
      schema: {
        type: "array",
        items: { type: "number" },
      },
    };

    console.log("准备创建隐私计算任务...");
    console.log("计算类型:", PrivacyComputeType.TEE);
    console.log("输入数据:", JSON.stringify(inputData, null, 2));

    // 创建隐私计算任务
    const taskResult = await privacy.createPrivacyTask(
      {
        computeType: PrivacyComputeType.TEE,
        inputData: inputData,
        encryptionLevel: "2",
        timeoutSeconds: 600,
        resultEncrypted: false,
      },
      {
        saveToBlockchain: true,
        notifyParties: false,
      },
      token,
    );

    if (!taskResult || !taskResult.success) {
      console.error("创建隐私计算任务失败:", taskResult?.message);
      return;
    }

    // 从响应中获取任务ID
    const taskId = taskResult.data.taskId;
    console.log("隐私计算任务创建成功! 任务ID:", taskId);

    // 3. 推送数据到隐私计算任务
    console.log("\n【3】推送数据到隐私计算任务");

    // 准备要计算的数据
    const calculationData = [10, 20, 30, 40, 50];
    console.log(`准备推送数据: [${calculationData.join(", ")}]`);

    // 推送数据
    const pushResult = await privacy.pushData(taskId, calculationData, token);

    if (!pushResult || !pushResult.success) {
      console.error("推送数据失败:", pushResult?.message);
      return;
    }

    console.log("数据推送成功!");

    // 4. 查询隐私计算任务状态
    console.log("\n【4】查询隐私计算任务状态");
    console.log("等待计算完成...");

    // 简单的轮询机制 - 实际应用中可能需要更复杂的方式
    let isCompleted = false;
    let attempts = 0;
    let taskStatus = null;

    while (!isCompleted && attempts < 5) {
      attempts++;

      // 等待一段时间
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 查询任务状态
      console.log(`第 ${attempts} 次查询任务状态...`);
      taskStatus = await privacy.queryTaskStatus(taskId, token);

      if (taskStatus && taskStatus.success) {
        const status = taskStatus.data.status;
        console.log("当前任务状态:", status);

        if (status === "COMPLETED" || status === "FAILED") {
          isCompleted = true;
        }
      } else {
        console.error("查询任务状态失败:", taskStatus?.message);
      }
    }

    // 5. 获取隐私计算结果
    if (isCompleted && taskStatus?.data.status === "COMPLETED") {
      console.log("\n【5】获取隐私计算结果");

      const resultParams = {
        requesterInfo: {
          id: defaultConfig.blockchain.accessId,
        },
        withProof: true,
      };

      const result = await privacy.getPrivacyResult(
        taskId,
        resultParams,
        token,
      );

      if (!result || !result.success) {
        console.error("获取计算结果失败:", result?.message);
      } else {
        console.log("计算结果:", result.data.result);
        if (result.data.proof) {
          console.log("结果证明:", result.data.proof);
        }

        // 验证结果 - 在本地计算平均值进行比较
        const expectedAvg = calculationData.reduce((a, b) => a + b, 0) /
          calculationData.length;
        console.log("本地验算结果:", expectedAvg);
        console.log(
          "验证",
          result.data.result === expectedAvg ? "成功" : "失败",
        );
      }
    } else {
      console.log("\n任务未完成或失败，无法获取结果");

      // 6. 如果任务失败，可以取消任务
      if (taskStatus?.data.status === "FAILED") {
        console.log("\n【6】取消失败的任务");

        const cancelResult = await privacy.cancelTask(
          taskId,
          "任务执行失败，手动取消",
          token,
        );

        if (!cancelResult || !cancelResult.success) {
          console.error("取消任务失败:", cancelResult?.message);
        } else {
          console.log("任务已成功取消");
        }
      }
    }

    console.log("\n=== 示例完成 ===");
  } catch (error) {
    console.error("示例运行错误:", error);
  }
}

// 运行示例
if (import.meta.url === Deno.mainModule) {
  main().catch((err) => {
    console.error("未处理的错误:", err);
  });
}

// 运行命令: deno run --allow-read --allow-env --allow-net src/examples/privacy-example.ts
