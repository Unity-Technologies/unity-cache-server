using UnityEngine;
using UnityEditor;
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;

public class CacheServerTransactionExporter : MonoBehaviour
{
    private const string TYPE_ASSET = "a";
    private const string TYPE_INFO = "i";
    private const string TYPE_RESOURCE = "r";
    
    [Serializable]
    public class CacheServerTransactionData : ISerializationCallbackReceiver
    {
        public string projectRoot;
        public Transaction[] transactions;
        
        private readonly List<Transaction> m_transactionList;
        
        public CacheServerTransactionData(int size)
        {
            projectRoot = Directory.GetParent(Application.dataPath).FullName;
            m_transactionList = new List<Transaction>(size);
        }
        
        public void AddItem(string assetPath)
        {
            if (Directory.Exists(assetPath)) return;
            if (!File.Exists(assetPath)) return;

            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            var hash = AssetDatabase.GetAssetDependencyHash(assetPath);

            var libPath = 
                new[] { projectRoot, "Library", "metadata", guid.Substring(0, 2), guid }
                .Aggregate(string.Empty, Path.Combine);
            
            if (!File.Exists(libPath))
            {
                Debug.Log("Cannot find Library representation for GUID " + guid);
                return;
            }

            var files = new List<Transaction.FileInfo>
            {
                new Transaction.FileInfo(TYPE_ASSET, libPath, ToUnixTime(File.GetLastWriteTime(libPath)))
            };

            var infoLibPath = libPath + ".info";
            if (File.Exists(infoLibPath))
            {
                files.Add(new Transaction.FileInfo(TYPE_INFO, infoLibPath, ToUnixTime(File.GetLastWriteTime(infoLibPath))));
            }

            var resLibPath = libPath + ".resource";
            if (File.Exists(resLibPath))
            {
                files.Add(new Transaction.FileInfo(TYPE_RESOURCE, resLibPath, ToUnixTime(File.GetLastWriteTime(resLibPath))));
            }

            m_transactionList.Add(new Transaction(assetPath, guid, hash, files.ToArray()));
        }

        public void OnBeforeSerialize()
        {
            transactions = m_transactionList.ToArray();
        }

        public void OnAfterDeserialize()
        {
            // No op
        }
    }
    
    [Serializable]
    public struct Transaction
    {

        [Serializable]
        public struct FileInfo
        {
            public string type;
            public string path;
            public long ts;

            public FileInfo(string type, string path, long ts)
            {
                this.type = type;
                this.path = path;
                this.ts = ts;
            }
        }

        public string assetPath;
        public string guid;
        public string hash;
        public FileInfo[] files;
        
        public Transaction(string assetPath, string guid, Hash128 hash, FileInfo[] files)
        {
            this.assetPath = assetPath;
            this.guid = guid;
            this.hash = hash.ToString();
            this.files = files;
        }
    }
    
    public static void ExportTransactions(string exportPath)
    {
        var assetPaths = AssetDatabase.GetAllAssetPaths();
        var data = new CacheServerTransactionData(assetPaths.Length);
        
        foreach (var path in assetPaths)
            data.AddItem(path);

        using (var stream = File.CreateText(exportPath))
            stream.Write(EditorJsonUtility.ToJson(data, true));
    }

    [MenuItem("Cache Server Utilities/Export Transactions")]
    public static void ExportTransactionsMenuItem()
    {
        var path = EditorUtility.SaveFilePanel(
            "Save Import Data", 
            Directory.GetCurrentDirectory(),
            "CacheServerTransactions_" + EditorUserBuildSettings.activeBuildTarget, "json");
        
        if (path.Length != 0)
            ExportTransactions(path);
    }
    
    public static long ToUnixTime(DateTime date)
    {
        var epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        return Convert.ToInt64((date.ToUniversalTime() - epoch).TotalSeconds);
    }
}
